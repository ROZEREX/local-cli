import React, { useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";
import { join, dirname } from "path";
import { theme, toolColor } from "./theme";
import { Markdown } from "./markdown";
import { readClipboard, sanitizeForInput } from "../clipboard";
import { listDirEntries } from "../files";
import type { DiffView } from "../diff";
import type { Hunk } from "../hunks";
import type { SessionMeta } from "../session";

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

const GRAD = [...theme.gradient];

// ─── Banner ─────────────────────────────────────────────────────────────────
// A compact gradient wordmark over a left-accent info rail — bounded, calm, and
// modern (opencode/Claude-flavored) rather than a heavy full box.
export function Banner({ model, baseUrl, cwd }: { model: string; baseUrl: string; cwd: string }) {
  const shortCwd = cwd.length > 52 ? "…" + cwd.slice(-51) : cwd;
  const server = baseUrl.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
  const row = (icon: string, label: string, value: React.ReactNode, valColor?: string) => (
    <Box>
      <Text color={theme.color.dim}>{icon}  </Text>
      <Text color={theme.color.dim}>{label.padEnd(7)}</Text>
      <Text color={valColor ?? theme.color.fg}>{value}</Text>
    </Box>
  );
  const hint = (key: string, label: string) => (
    <Text>
      <Text color={theme.color.accent}>{key}</Text>
      <Text color={theme.color.dim}> {label}</Text>
    </Text>
  );
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Gradient colors={GRAD}>
        <BigText text="local cli" font="tiny" />
      </Gradient>
      <Box marginTop={-1} paddingLeft={1}>
        <Text color={theme.color.dim}>{theme.icon.spark} agentic coding on your own models</Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.color.primary}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={2}
        marginTop={1}
        marginLeft={1}
      >
        {row(theme.icon.model, "model", model, theme.color.primary)}
        {row(theme.icon.folder, "folder", shortCwd)}
        {row(theme.icon.server, "server", server, theme.color.dim)}
      </Box>
      <Box paddingLeft={1} marginTop={1} flexWrap="wrap">
        <Text color={theme.color.dim}>{"   "}</Text>
        {hint("/add", "files")}<Text color={theme.color.dim}>{"   "}</Text>
        {hint("/chats", "history")}<Text color={theme.color.dim}>{"   "}</Text>
        {hint("/help", "commands")}<Text color={theme.color.dim}>{"   "}</Text>
        {hint("shift+tab", "mode")}<Text color={theme.color.dim}>{"   "}</Text>
        {hint("esc", "stop")}
      </Box>
    </Box>
  );
}

// ─── User message ────────────────────────────────────────────────────────────
// Minimal: a colored prompt glyph and the text. No box — the glyph alone marks
// the turn, keeping the transcript light (Claude-style).
export function UserMessage({ text }: { text: string }) {
  return (
    <Box marginTop={1}>
      <Text color={theme.color.user} bold>{theme.icon.user} </Text>
      <Box flexGrow={1}>
        <Text color={theme.color.muted}>{text}</Text>
      </Box>
    </Box>
  );
}

// ─── Assistant message ───────────────────────────────────────────────────────
// A filled bullet heads each turn; the body flows in an indented column so
// wrapped lines stay aligned under the text, not the glyph. `live` renders plain
// text while streaming (markdown reflow looks janky on partial input).
export function AssistantMessage({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim()) return null;
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.color.primary} bold>{theme.icon.assistant} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {live
          ? <Text color={theme.color.fg}>{text}<Text color={theme.color.primary}>{theme.icon.cursor}</Text></Text>
          : <Markdown text={text} />}
      </Box>
    </Box>
  );
}

// ─── Thinking block ──────────────────────────────────────────────────────────
export function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim()) return null;
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={theme.color.think}>{theme.icon.thinking} </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.color.think} italic dimColor>
          {text.trim()}
          {live ? <Text> {theme.icon.cursor}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Tool card ───────────────────────────────────────────────────────────────
// `⏺ name(args)` on the header line, the result hanging beneath on a `⎿` tree
// connector — the recognizable modern coding-agent shape, no surrounding box.
export interface ToolView {
  name: string;
  summary: string;
  result?: string;
  status: "running" | "done" | "denied";
}

export function ToolCard({ tool }: { tool: ToolView }) {
  const accent = toolColor[tool.name] ?? theme.color.tool;
  const bullet =
    tool.status === "running" ? (
      <Text color={theme.color.accent}><Spinner type="dots" /></Text>
    ) : tool.status === "denied" ? (
      <Text color={theme.color.error}>{theme.icon.assistant}</Text>
    ) : (
      <Text color={theme.color.success}>{theme.icon.assistant}</Text>
    );

  const resultLines = (tool.result ?? "").split("\n").filter(Boolean);
  const preview = resultLines.slice(0, 8);
  const more = resultLines.length - preview.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {bullet}
        <Text> </Text>
        <Text color={accent} bold>{tool.name}</Text>
        {tool.summary ? (
          <Text color={theme.color.dim}>(<Text color={theme.color.muted}>{tool.summary}</Text>)</Text>
        ) : null}
      </Box>
      {tool.status !== "running" && preview.length > 0 ? (
        <Box flexDirection="column">
          {preview.map((l, i) => {
            const isErr = tool.status === "denied" ||
                          l.startsWith("Error:") ||
                          l.startsWith("Exit ") ||
                          /failed/i.test(l) ||
                          /syntax of the command is incorrect/i.test(l);
            const body = l.length > 140 ? l.slice(0, 140) + "…" : l;
            return (
              <Text key={i} color={isErr ? theme.color.error : theme.color.muted}>
                <Text color={theme.color.dim}>{i === 0 ? `  ${theme.icon.branch} ` : "    "}</Text>
                {body}
              </Text>
            );
          })}
          {more > 0 ? (
            <Text color={tool.status === "denied" ? theme.color.error : theme.color.dim} italic>
              {"    "}+{more} more line{more > 1 ? "s" : ""}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

// ─── System / command output ─────────────────────────────────────────────────
export function SystemMessage({ text, tone }: { text: string; tone?: "info" | "error" }) {
  const color = tone === "error" ? theme.color.error : theme.color.dim;
  const glyph = tone === "error" ? theme.icon.warn : theme.icon.bullet;
  const lines = text.split("\n");
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={color}>{glyph} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {lines.map((l, i) => (
          <Text key={i} color={color}>{l}</Text>
        ))}
      </Box>
    </Box>
  );
}

// ─── Status bar ──────────────────────────────────────────────────────────────
// Borderless quiet line above the framed input: mode badge + status on the left,
// model + context meter on the right.
export type StatusState = "idle" | "thinking" | "permission";

export function StatusBar({
  model,
  tokens,
  contextWindow,
  status,
  mode,
}: {
  model: string;
  tokens: number;
  contextWindow: number;
  status: StatusState;
  mode: "normal" | "plan" | "auto" | "debug";
}) {
  const pct = Math.min(100, Math.round((tokens / contextWindow) * 100));
  const pctColor = pct > 85 ? theme.color.error : pct > 65 ? theme.color.warn : theme.color.dim;

  const statusEl =
    status === "thinking" ? (
      <Text color={theme.color.warn}>{theme.icon.dot} working</Text>
    ) : status === "permission" ? (
      <Text color={theme.color.accent}>{theme.icon.warn} awaiting approval</Text>
    ) : (
      <Text color={theme.color.success}>{theme.icon.ok} ready</Text>
    );

  const badge =
    mode === "plan" ? <Text backgroundColor={theme.color.accent} color="black" bold> PLAN </Text> :
    mode === "auto" ? <Text backgroundColor={theme.color.warn} color="black" bold> AUTO </Text> :
    mode === "debug" ? <Text backgroundColor={theme.color.error} color="black" bold> DEBUG </Text> :
    null;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        {badge}
        <Text>{badge ? " " : ""}{statusEl}</Text>
      </Box>
      <Box>
        <Text color={theme.color.dim}>{theme.icon.model} </Text>
        <Text color={theme.color.primary}>{model}</Text>
        <Text color={theme.color.dim}>   {theme.icon.tokens} </Text>
        <ContextBar pct={pct} color={pctColor} />
        <Text color={pctColor}> {pct}%</Text>
        <Text color={theme.color.dim}> · {fmtTok(tokens)}/{fmtTok(contextWindow)}</Text>
      </Box>
    </Box>
  );
}

const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));

// Mini context-usage meter: ▰▰▰▱▱▱▱▱▱▱
function ContextBar({ pct, color }: { pct: number; color: string }) {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return (
    <Text>
      <Text color={color}>{theme.icon.barFull.repeat(filled)}</Text>
      <Text color={theme.color.dim}>{theme.icon.barEmpty.repeat(cells - filled)}</Text>
    </Text>
  );
}

// ─── Generating indicator (the single live activity line while streaming) ─────
// Phase-aware: distinguishes a model being LOADED into memory from prompt
// prefill from actual thinking/writing — so a silent wait is never ambiguous.
export type LivePhase = "loading" | "prefill" | "generating" | null;

export function GeneratingLine({
  tokens,
  elapsed,
  phase,
  thinking,
}: {
  tokens: number;
  elapsed: number;
  phase?: LivePhase;
  thinking?: boolean;
}) {
  const liveTps = elapsed > 0 ? Math.round(tokens / elapsed) : 0;
  const label =
    phase === "loading" ? "loading model into memory" :
    tokens === 0 && phase === "prefill" ? "reading the prompt" :
    tokens === 0 ? "waiting for the model" :
    thinking ? "thinking" : "writing";
  const note =
    phase === "loading" ? "  (cold start — can take a while)" :
    tokens === 0 && phase === "prefill" ? "  (prefill)" : "";
  return (
    <Box paddingX={1}>
      <Text color={thinking && tokens > 0 ? theme.color.think : theme.color.accent}>
        <Spinner type="dots" /> {label}{" "}
      </Text>
      {tokens > 0 ? <Text color={theme.color.success}>↓{tokens.toLocaleString()} tok</Text> : null}
      <Text color={theme.color.dim}>{tokens > 0 ? " · " : ""}{elapsed}s</Text>
      {liveTps && tokens > 0 ? <Text color={theme.color.dim}> · {liveTps} t/s</Text> : null}
      {note ? <Text color={theme.color.dim}>{note}</Text> : null}
      <Text color={theme.color.dim}>   ·  esc to stop</Text>
    </Box>
  );
}

// ─── Diff preview ─────────────────────────────────────────────────────────────
export function DiffPreview({ diff }: { diff: DiffView }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.color.success} bold>+{diff.added}</Text>
        <Text color={theme.color.dim}>  </Text>
        <Text color={theme.color.error} bold>-{diff.removed}</Text>
      </Text>
      {diff.lines.map((l, i) => (
        <Text
          key={i}
          color={l.type === "add" ? theme.color.success : l.type === "del" ? theme.color.error : theme.color.dim}
        >
          <Text color={theme.color.dim}>{l.type === "add" ? "│ " : l.type === "del" ? "│ " : "│ "}</Text>
          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
          {l.text.length > 128 ? l.text.slice(0, 128) + "…" : l.text}
        </Text>
      ))}
      {diff.truncated > 0 ? <Text color={theme.color.dim} italic>{"│ "}{theme.icon.ellipsis} {diff.truncated} more changed lines</Text> : null}
    </Box>
  );
}

// ─── Permission prompt ───────────────────────────────────────────────────────
// For file edits with a multi-hunk diff, [s] opens an interactive hunk selector
// so the user can apply only PART of the proposed change (Cursor-style).
export function PermissionPrompt({
  name,
  detail,
  diff,
  hunks,
  onPartial,
  onDecide,
}: {
  name: string;
  detail: string;
  diff?: DiffView;
  hunks?: Hunk[];
  onPartial?: (selectedHunks: number[]) => void;
  onDecide: (decision: "yes" | "no" | "always") => void;
}) {
  const canSelect = !!onPartial && !!hunks && hunks.length >= 2;
  const [selecting, setSelecting] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(() => new Set((hunks ?? []).map(h => h.index)));

  useInput((input, key) => {
    const c = input.toLowerCase();
    if (selecting) {
      if (key.upArrow) setCursor(i => Math.max(0, i - 1));
      else if (key.downArrow) setCursor(i => Math.min((hunks?.length ?? 1) - 1, i + 1));
      else if (input === " ") {
        setPicked(prev => {
          const next = new Set(prev);
          const idx = hunks![cursor]!.index;
          next.has(idx) ? next.delete(idx) : next.add(idx);
          return next;
        });
      } else if (key.return) {
        if (picked.size === 0) onDecide("no");
        else if (picked.size === hunks!.length) onDecide("yes");
        else onPartial!([...picked].sort((a, b) => a - b));
      } else if (key.escape) setSelecting(false);
      return;
    }
    if (c === "y") onDecide("yes");
    else if (c === "a") onDecide("always");
    else if (c === "s" && canSelect) setSelecting(true);
    else if (c === "n" || key.escape) onDecide("no");
    else if (key.return) onDecide("no"); // default = deny
  });

  if (selecting && hunks) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.color.warn} paddingX={1}>
        <Box>
          <Text color={theme.color.warn} bold>{theme.icon.warn} select hunks </Text>
          <Text color={theme.color.tool} bold>{name}</Text>
          <Text color={theme.color.dim}>  — apply only the changes you check</Text>
        </Box>
        {hunks.map((h, i) => (
          <Box key={h.index} flexDirection="column">
            <Text color={i === cursor ? theme.color.accent : undefined}>
              {i === cursor ? `${theme.icon.user} ` : "  "}
              {picked.has(h.index) ? theme.icon.radioOn : theme.icon.radioOff}{" "}
              <Text color={theme.color.success}>+{h.added}</Text>
              <Text color={theme.color.error}> -{h.removed}</Text>
              <Text color={theme.color.dim}>  {h.header}</Text>
            </Text>
            {i === cursor
              ? h.lines.slice(0, 6).map((l, j) => (
                  <Text key={j} color={l.type === "add" ? theme.color.success : theme.color.error}>
                    {"      "}{l.type === "add" ? "+ " : "- "}
                    {l.text.length > 110 ? l.text.slice(0, 110) + "…" : l.text}
                  </Text>
                ))
              : null}
            {i === cursor && h.lines.length > 6 ? <Text color={theme.color.dim} italic>{"      "}{theme.icon.ellipsis} {h.lines.length - 6} more lines</Text> : null}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={theme.color.dim}>↑↓ move · space toggle · enter apply {picked.size}/{hunks.length} · esc back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.warn} paddingX={1}>
      <Box>
        <Text color={theme.color.warn} bold>{theme.icon.warn} permission </Text>
        <Text color={theme.color.tool} bold>{name}</Text>
      </Box>
      <Text color={theme.color.muted}>{detail}</Text>
      {diff ? <DiffPreview diff={diff} /> : null}
      <Box marginTop={1}>
        <Text>
          <Text color={theme.color.success} bold>y</Text><Text color={theme.color.dim}> allow   </Text>
          <Text color={theme.color.error} bold>n</Text><Text color={theme.color.dim}> deny   </Text>
          <Text color={theme.color.primary} bold>a</Text><Text color={theme.color.dim}> always   </Text>
          {canSelect ? <><Text color={theme.color.accent} bold>s</Text><Text color={theme.color.dim}> select hunks</Text></> : null}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Select list (arrow-key picker) ──────────────────────────────────────────
export interface SelectItem { label: string; value: string; hint?: string; }

export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
}: {
  title: string;
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}) {
  const [idx, setIdx] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setIdx(i => Math.max(0, i - 1));
    else if (key.downArrow) setIdx(i => Math.min(items.length - 1, i + 1));
    else if (key.return) { const it = items[idx]; if (it) onSelect(it.value); }
    else if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.primary} paddingX={1}>
      <Text bold color={theme.color.primary}>{theme.icon.spark} {title}</Text>
      {items.length === 0 ? (
        <Text color={theme.color.dim}>  (none)</Text>
      ) : (
        items.map((it, i) => (
          <Text key={it.value} color={i === idx ? theme.color.accent : theme.color.fg}>
            {i === idx ? `${theme.icon.user} ` : "  "}
            {it.label}
            {it.hint ? <Text color={theme.color.dim}>   {it.hint}</Text> : null}
          </Text>
        ))
      )}
      <Box marginTop={1}><Text color={theme.color.dim}>↑↓ move · enter select · esc cancel</Text></Box>
    </Box>
  );
}

// ─── Prompt input (cursor editing, history, clipboard paste) ─────────────────
// A controlled-by-refs single-field editor. ink-text-input can't paste or recall
// history, so we own key handling: printable insert, cursor moves, backspace,
// up/down history recall, and Ctrl+V which reads the real system clipboard
// (terminals deliver Ctrl+V as a control byte, not the clipboard text).
export function PromptInput({
  placeholder,
  color,
  onSubmit,
  history,
  commands = [],
  pasteSource = readClipboard,
}: {
  placeholder: string;
  color: string;
  onSubmit: (value: string) => void;
  history: React.MutableRefObject<string[]>;
  commands?: { name: string; description: string }[];
  pasteSource?: () => Promise<string>;
}) {
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  const histIdx = useRef(-1);   // -1 = editing a live draft
  const draft = useRef("");
  const menuIdxRef = useRef(0);     // highlighted item in the slash-command menu
  const menuDismissed = useRef(false); // esc hides the menu until the text changes
  const [, force] = useReducer((x: number) => x + 1, 0);

  // The slash-command menu shows while the user is typing a command name —
  // i.e. the buffer is "/" followed by only word chars, no space yet. Returns
  // the filtered command list, or null when the menu shouldn't show.
  const menuItems = (): { name: string; description: string }[] | null => {
    if (menuDismissed.current) return null;
    const m = /^\/([a-zA-Z]*)$/.exec(valueRef.current);
    if (!m) return null;
    const q = (m[1] ?? "").toLowerCase();
    const items = commands.filter(c => c.name.toLowerCase().startsWith(q));
    return items.length ? items : null;
  };

  const setVal = (v: string, c: number) => {
    valueRef.current = v; cursorRef.current = c;
    menuDismissed.current = false; menuIdxRef.current = 0;
    force();
  };
  const insert = (text: string) => {
    const v = valueRef.current, c = cursorRef.current;
    setVal(v.slice(0, c) + text + v.slice(c), c + text.length);
  };

  useInput((input, key) => {
    // ── Slash-command menu navigation (takes over keys while it's open) ──
    const menu = menuItems();
    if (menu) {
      const idx = Math.min(menuIdxRef.current, menu.length - 1);
      if (key.escape) { menuDismissed.current = true; force(); return; }
      if (key.upArrow) { menuIdxRef.current = Math.max(0, idx - 1); force(); return; }
      if (key.downArrow) { menuIdxRef.current = Math.min(menu.length - 1, idx + 1); force(); return; }
      // Tab completes the highlighted command into the input (ready for args).
      if (key.tab && !key.shift) { const name = menu[idx]!.name; setVal(`/${name} `, name.length + 2); return; }
      // Enter runs the highlighted command immediately.
      if (key.return) {
        const cmd = `/${menu[idx]!.name}`;
        history.current.push(cmd);
        histIdx.current = -1; draft.current = "";
        setVal("", 0);
        onSubmit(cmd);
        return;
      }
    }

    if (key.tab) return; // reserved for mode cycling at the app level

    if (key.return) {
      const v = valueRef.current;
      if (v.trim()) history.current.push(v);
      histIdx.current = -1; draft.current = "";
      setVal("", 0);
      onSubmit(v);
      return;
    }

    if (key.upArrow) {
      const h = history.current;
      if (h.length === 0) return;
      if (histIdx.current === -1) { draft.current = valueRef.current; histIdx.current = h.length; }
      histIdx.current = Math.max(0, histIdx.current - 1);
      const v = h[histIdx.current] ?? "";
      setVal(v, v.length);
      return;
    }
    if (key.downArrow) {
      const h = history.current;
      if (histIdx.current === -1) return;
      if (histIdx.current >= h.length - 1) { histIdx.current = -1; setVal(draft.current, draft.current.length); }
      else { histIdx.current += 1; const v = h[histIdx.current] ?? ""; setVal(v, v.length); }
      return;
    }

    if (key.leftArrow) { cursorRef.current = Math.max(0, cursorRef.current - 1); force(); return; }
    if (key.rightArrow) { cursorRef.current = Math.min(valueRef.current.length, cursorRef.current + 1); force(); return; }

    if (key.backspace || key.delete) {
      const v = valueRef.current, c = cursorRef.current;
      if (c > 0) setVal(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }

    if (key.ctrl && (input === "v" || input === "y")) {
      // Ctrl+V (and Ctrl+Y as a fallback some terminals send) → paste.
      void pasteSource().then(text => { const clean = sanitizeForInput(text); if (clean) insert(clean); });
      return;
    }
    if (key.ctrl && input === "u") { setVal("", 0); return; } // clear line
    if (key.ctrl || key.meta) return;

    // Printable input. A multi-char chunk is a paste the terminal delivered
    // directly (often wrapped in bracketed-paste escapes) — sanitize it so no
    // escape sequence is ever inserted and rendered back to the terminal.
    if (input) {
      const clean = sanitizeForInput(input);
      if (clean) insert(clean);
    }
  });

  const v = valueRef.current;
  const c = cursorRef.current;
  const menu = menuItems();
  const menuSel = menu ? Math.min(menuIdxRef.current, menu.length - 1) : 0;

  const inputBox = !v ? (
    <Box borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} bold>{theme.icon.user} </Text>
      <Text inverse> </Text>
      <Text color={theme.color.dim}>{placeholder}</Text>
    </Box>
  ) : (
    <Box borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} bold>{theme.icon.user} </Text>
      <Text color={theme.color.fg}>{v.slice(0, c)}<Text inverse>{v[c] ?? " "}</Text>{v.slice(c + 1)}</Text>
    </Box>
  );

  if (!menu) return inputBox;

  // The slash-command menu: filtered list with descriptions.
  const WINDOW = 8;
  const start = Math.max(0, Math.min(menuSel - Math.floor(WINDOW / 2), Math.max(0, menu.length - WINDOW)));
  const visible = menu.slice(start, start + WINDOW);
  const nameW = Math.max(...menu.map(m => m.name.length));
  return (
    <Box flexDirection="column">
      {inputBox}
      <Box flexDirection="column" borderStyle="round" borderColor={theme.color.primary} paddingX={1}>
        <Text bold color={theme.color.primary}>{theme.icon.spark} commands {menu.length > WINDOW ? <Text color={theme.color.dim}>({menu.length})</Text> : null}</Text>
        {visible.map((cmd, i) => {
          const active = start + i === menuSel;
          return (
            <Text key={cmd.name} color={active ? theme.color.accent : undefined}>
              {active ? `${theme.icon.user} ` : "  "}
              <Text color={active ? theme.color.accent : theme.color.fg}>/{cmd.name.padEnd(nameW)}</Text>
              <Text color={theme.color.dim}>  {cmd.description}</Text>
            </Text>
          );
        })}
        <Box marginTop={1}><Text color={theme.color.dim}>↑↓ move · tab complete · enter run · esc close</Text></Box>
      </Box>
    </Box>
  );
}

// ─── Plan approval prompt ────────────────────────────────────────────────────
export function PlanApproval({ onDecide }: { onDecide: (d: "approve" | "keep" | "cancel") => void }) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "a" || key.return) onDecide("approve");
    else if (c === "k") onDecide("keep");
    else if (key.escape || c === "n") onDecide("cancel");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.accent} paddingX={1}>
      <Text color={theme.color.accent} bold>{theme.icon.thinking} plan ready</Text>
      <Box marginTop={1}>
        <Text>
          <Text color={theme.color.success} bold>a</Text><Text color={theme.color.dim}> approve & build   </Text>
          <Text color={theme.color.primary} bold>k</Text><Text color={theme.color.dim}> keep planning   </Text>
          <Text color={theme.color.error} bold>esc</Text><Text color={theme.color.dim}> cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ─── Chat browser (persistent conversations — switch / new / delete) ──────────
export function ChatBrowser({
  sessions,
  activeId,
  onSwitch,
  onNew,
  onDelete,
  onCancel,
}: {
  sessions: SessionMeta[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onCancel: () => void;
}) {
  const [idx, setIdx] = useState(0);
  // index 0 = "new chat", then one row per session.
  const total = sessions.length + 1;
  const cur = Math.min(idx, total - 1);

  useInput((input, key) => {
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(total - 1, i + 1)); return; }
    if (key.return) { cur === 0 ? onNew() : onSwitch(sessions[cur - 1]!.id); return; }
    if (input === "n") { onNew(); return; }
    if (input === "d" && cur > 0) { onDelete(sessions[cur - 1]!.id); setIdx(c => Math.min(c, total - 2)); return; }
    if (key.escape) { onCancel(); return; }
  });

  const WINDOW = 10;
  const startRow = Math.max(0, Math.min(cur - Math.floor(WINDOW / 2), Math.max(0, sessions.length - WINDOW + 1)));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.primary} paddingX={1}>
      <Text bold color={theme.color.primary}>{theme.icon.spark} chats — {sessions.length} saved</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={cur === 0 ? theme.color.accent : theme.color.success}>
          {cur === 0 ? `${theme.icon.user} ` : "  "}{theme.icon.spark} new chat
        </Text>
        {sessions.slice(startRow, startRow + WINDOW).map((s, i) => {
          const realIdx = startRow + i + 1;
          const active = realIdx === cur;
          const isCurrent = s.id === activeId;
          return (
            <Text key={s.id} color={active ? theme.color.accent : theme.color.fg}>
              {active ? `${theme.icon.user} ` : "  "}
              {isCurrent ? <Text color={theme.color.success}>{theme.icon.dot} </Text> : "  "}
              {s.title}
              <Text color={theme.color.dim}>  · {relTime(s.updatedAt)} · {s.messageCount} msg · {s.model}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.color.dim}>
          ↑↓ move · <Text color={theme.color.accent}>enter</Text> open · <Text color={theme.color.success}>n</Text> new ·{" "}
          <Text color={theme.color.error}>d</Text> delete · <Text color={theme.color.error}>esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}

// ─── File browser (navigate folders, multi-select files for context) ──────────
export function FileBrowser({
  startDir,
  onConfirm,
  onCancel,
}: {
  startDir: string;
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState(startDir);
  const [idx, setIdx] = useState(0);
  const selected = useRef<Set<string>>(new Set());
  const [, force] = useReducer((x: number) => x + 1, 0);

  const entries = useMemo(() => listDirEntries(dir), [dir]);
  const cur = Math.min(idx, Math.max(0, entries.length - 1));

  const toggle = (p: string) => {
    if (selected.current.has(p)) selected.current.delete(p);
    else selected.current.add(p);
    force();
  };

  useInput((input, key) => {
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx(i => Math.min(entries.length - 1, i + 1)); return; }
    const e = entries[cur];
    if (key.return) {
      if (!e) return;
      if (e.isDir) { setDir(e.name === ".." ? dirname(dir) : join(dir, e.name)); setIdx(0); }
      else { toggle(join(dir, e.name)); }
      return;
    }
    if (input === " ") { if (e && e.name !== "..") toggle(join(dir, e.name)); return; }
    if (input === "a") { onConfirm([...selected.current]); return; }
    if (key.escape) { onCancel(); return; }
  });

  const count = selected.current.size;
  // window the list so long dirs don't overflow
  const WINDOW = 12;
  const start = Math.max(0, Math.min(cur - Math.floor(WINDOW / 2), Math.max(0, entries.length - WINDOW)));
  const view = entries.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.accent} paddingX={1}>
      <Text bold color={theme.color.accent}>{theme.icon.folder} add files to context</Text>
      <Text color={theme.color.dim}>{dir}</Text>
      <Box flexDirection="column" marginTop={1}>
        {view.length === 0 ? <Text color={theme.color.dim}>  (empty)</Text> : view.map((e) => {
          const i = start + view.indexOf(e);
          const full = join(dir, e.name);
          const sel = selected.current.has(full);
          const active = i === cur;
          const mark = e.name === ".." ? "  " : sel ? `${theme.icon.ok} ` : "  ";
          const label = e.isDir ? `${e.name}/` : e.name;
          return (
            <Text key={e.name} color={active ? theme.color.accent : sel ? theme.color.success : e.isDir ? theme.color.primary : theme.color.fg}>
              {active ? `${theme.icon.user} ` : "  "}{mark}{e.isDir ? `${theme.icon.folder} ` : ""}{label}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.color.dim}>
          ↑↓ move · <Text color={theme.color.accent}>enter</Text> open/select · <Text color={theme.color.accent}>space</Text> select ·{" "}
          <Text color={theme.color.success} bold>a</Text> add ({count}) · <Text color={theme.color.error}>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}
