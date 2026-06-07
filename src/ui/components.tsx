import React, { useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";
import { join, dirname } from "path";
import { theme, toolIcon, toolColor } from "./theme";
import { Markdown } from "./markdown";
import { readClipboard, sanitizeForInput } from "../clipboard";
import { listDirEntries } from "../files";
import type { DiffView } from "../diff";
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

// A small rounded "pill" used in the banner / status bar.
function Pill({ icon, label, color }: { icon: string; label: string; color: string }) {
  return (
    <Text>
      <Text color={color}>{icon} </Text>
      <Text color={theme.color.fg}>{label}</Text>
    </Text>
  );
}

// ─── Banner ─────────────────────────────────────────────────────────────────
export function Banner({ model, baseUrl, cwd }: { model: string; baseUrl: string; cwd: string }) {
  const shortCwd = cwd.length > 48 ? "…" + cwd.slice(-47) : cwd;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Gradient colors={GRAD}>
        <BigText text="local cli" font="tiny" />
      </Gradient>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.color.dim}
        paddingX={1}
      >
        <Box>
          <Pill icon={theme.icon.model} label={model} color={theme.color.primary} />
          <Text color={theme.color.dim}>   {theme.icon.folder} </Text>
          <Text color={theme.color.fg}>{shortCwd}</Text>
        </Box>
        <Text color={theme.color.dim}>{baseUrl}</Text>
      </Box>
      <Box paddingLeft={1} marginTop={0}>
        <Text color={theme.color.dim}>
          <Text color={theme.color.accent}>/add</Text> files ·{" "}
          <Text color={theme.color.accent}>/chats</Text> history ·{" "}
          <Text color={theme.color.accent}>/help</Text> ·{" "}
          <Text color={theme.color.accent}>shift+tab</Text> mode ·{" "}
          <Text color={theme.color.accent}>esc</Text> stop
        </Text>
      </Box>
    </Box>
  );
}

// ─── User message ────────────────────────────────────────────────────────────
// A cyan left-accent bar with a "you" label — chat-bubble feel without the
// visual weight of a full box on every message.
export function UserMessage({ text }: { text: string }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.color.user} bold>{theme.icon.user} you</Text>
      <Box borderStyle="round" borderColor={theme.color.user} borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
        <Text color={theme.color.fg}>{text}</Text>
      </Box>
    </Box>
  );
}

// ─── Assistant message ───────────────────────────────────────────────────────
// `live` renders plain text while streaming (markdown reflow looks janky on
// partial input); committed messages get full markdown formatting.
export function AssistantMessage({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim()) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Gradient colors={GRAD}><Text bold>{theme.icon.assistant} assistant</Text></Gradient>
      <Box
        borderStyle="round"
        borderColor={theme.color.primary}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        flexDirection="column"
      >
        {live ? <Text color={theme.color.fg}>{text}<Text color={theme.color.primary}>▍</Text></Text> : <Markdown text={text} />}
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
          {live ? <Text> ▍</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Tool card ───────────────────────────────────────────────────────────────
export interface ToolView {
  name: string;
  summary: string;
  result?: string;
  status: "running" | "done" | "denied";
}

export function ToolCard({ tool }: { tool: ToolView }) {
  const icon = toolIcon[tool.name] ?? theme.icon.tool;
  const accent = toolColor[tool.name] ?? theme.color.tool;
  const statusEl =
    tool.status === "running" ? (
      <Text color={theme.color.warn}><Spinner type="dots" /></Text>
    ) : tool.status === "denied" ? (
      <Text color={theme.color.error}>{theme.icon.fail}</Text>
    ) : (
      <Text color={theme.color.success}>{theme.icon.ok}</Text>
    );

  const resultLines = (tool.result ?? "").split("\n").filter(Boolean);
  const preview = resultLines.slice(0, 8);
  const more = resultLines.length - preview.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text>{statusEl} </Text>
        <Text color={accent} bold>{icon} {tool.name}</Text>
        <Text color={theme.color.dim}>  {tool.summary}</Text>
      </Box>
      {tool.status !== "running" && preview.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tool.status === "denied" ? theme.color.error : accent}
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          paddingLeft={1}
          marginLeft={1}
        >
          {preview.map((l, i) => {
            const isErr = tool.status === "denied" || 
                          l.startsWith("Error:") || 
                          l.startsWith("Exit ") || 
                          /failed/i.test(l) || 
                          /syntax of the command is incorrect/i.test(l);
            return (
              <Text
                key={i}
                color={isErr ? theme.color.error : undefined}
                dimColor={!isErr}
              >
                {l.length > 140 ? l.slice(0, 140) + "…" : l}
              </Text>
            );
          })}
          {more > 0 ? (
            <Text
              color={tool.status === "denied" ? theme.color.error : undefined}
              dimColor={tool.status !== "denied"}
              italic
            >
              … {more} more line{more > 1 ? "s" : ""}
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
  return (
    <Box marginTop={1} flexDirection="column" paddingLeft={1}>
      {text.split("\n").map((l, i) => (
        <Text key={i} color={color}>{l}</Text>
      ))}
    </Box>
  );
}

// ─── Status bar ──────────────────────────────────────────────────────────────
export type StatusState = "idle" | "thinking" | "permission";

const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));

export function StatusBar({
  model,
  cwd,
  tokens,
  contextWindow,
  status,
  mode,
  readTok = 0,
  writeTok = 0,
  tps = 0,
}: {
  model: string;
  cwd: string;
  tokens: number;
  contextWindow: number;
  status: StatusState;
  mode: "normal" | "plan" | "auto";
  readTok?: number;
  writeTok?: number;
  tps?: number;
}) {
  const pct = Math.min(100, Math.round((tokens / contextWindow) * 100));
  const pctColor = pct > 85 ? theme.color.error : pct > 65 ? theme.color.warn : theme.color.dim;

  const statusEl =
    status === "thinking" ? (
      <Text color={theme.color.warn}><Spinner type="dots" /> working</Text>
    ) : status === "permission" ? (
      <Text color={theme.color.accent}>{theme.icon.warn} awaiting approval</Text>
    ) : (
      <Text color={theme.color.success}>{theme.icon.ok} ready</Text>
    );

  const badge =
    mode === "plan" ? <Text backgroundColor={theme.color.accent} color="black" bold> PLAN </Text> :
    mode === "auto" ? <Text backgroundColor={theme.color.warn} color="black" bold> AUTO </Text> :
    null;

  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.color.dim} paddingX={1} justifyContent="space-between">
      <Box marginRight={2}>
        {badge}
        <Text> {statusEl}</Text>
      </Box>
      <Box>
        <Text color={theme.color.user}>↑{fmtTok(readTok)} </Text>
        <Text color={theme.color.success}>↓{fmtTok(writeTok)}</Text>
        {tps ? <Text color={theme.color.dim}> {Math.round(tps)} t/s</Text> : null}
        <Text dimColor>   {theme.icon.model} </Text>
        <Text color={theme.color.primary}>{model}</Text>
        <Text dimColor>   {theme.icon.tokens} </Text>
        <Text color={pctColor}>{pct}%</Text>
      </Box>
    </Box>
  );
}

// ─── Generating indicator (live activity while the model streams) ────────────
export function GeneratingLine({ tokens, elapsed, tps }: { tokens: number; elapsed: number; tps: number }) {
  return (
    <Box>
      <Text color={theme.color.warn}><Spinner type="dots" /> generating </Text>
      <Text color={theme.color.success}>↓{tokens.toLocaleString()} tok</Text>
      <Text color={theme.color.dim}> · {elapsed}s</Text>
      {tps ? <Text color={theme.color.dim}> · {Math.round(tps)} t/s</Text> : null}
      <Text color={theme.color.dim}>   ·  esc to stop</Text>
    </Box>
  );
}

// ─── Diff preview ─────────────────────────────────────────────────────────────
export function DiffPreview({ diff }: { diff: DiffView }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        <Text color={theme.color.success}>+{diff.added}</Text>{" "}
        <Text color={theme.color.error}>-{diff.removed}</Text>
      </Text>
      {diff.lines.map((l, i) => (
        <Text
          key={i}
          color={l.type === "add" ? theme.color.success : l.type === "del" ? theme.color.error : undefined}
          dimColor={l.type === "ctx"}
        >
          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
          {l.text.length > 130 ? l.text.slice(0, 130) + "…" : l.text}
        </Text>
      ))}
      {diff.truncated > 0 ? <Text dimColor italic>⋯ {diff.truncated} more changed lines</Text> : null}
    </Box>
  );
}

// ─── Permission prompt ───────────────────────────────────────────────────────
export function PermissionPrompt({
  name,
  detail,
  diff,
  onDecide,
}: {
  name: string;
  detail: string;
  diff?: DiffView;
  onDecide: (decision: "yes" | "no" | "always") => void;
}) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y") onDecide("yes");
    else if (c === "a") onDecide("always");
    else if (c === "n" || key.escape) onDecide("no");
    else if (key.return) onDecide("no"); // default = deny
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.warn} paddingX={1}>
      <Box>
        <Text color={theme.color.warn} bold>{theme.icon.warn} permission </Text>
        <Text color={theme.color.tool} bold>{name}</Text>
      </Box>
      <Text dimColor>{detail}</Text>
      {diff ? <DiffPreview diff={diff} /> : null}
      <Box marginTop={1}>
        <Text>
          <Text color={theme.color.success} bold>y</Text><Text dimColor> allow   </Text>
          <Text color={theme.color.error} bold>n</Text><Text dimColor> deny   </Text>
          <Text color={theme.color.primary} bold>a</Text><Text dimColor> always allow this tool</Text>
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
      <Text bold color={theme.color.primary}>{title}</Text>
      {items.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : (
        items.map((it, i) => (
          <Text key={it.value} color={i === idx ? theme.color.accent : undefined}>
            {i === idx ? "❯ " : "  "}
            {it.label}
            {it.hint ? <Text dimColor>   {it.hint}</Text> : null}
          </Text>
        ))
      )}
      <Box marginTop={1}><Text dimColor>↑↓ move · enter select · esc cancel</Text></Box>
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

  // The slash-command menu, like Claude's: filtered list with descriptions.
  const WINDOW = 8;
  const start = Math.max(0, Math.min(menuSel - Math.floor(WINDOW / 2), Math.max(0, menu.length - WINDOW)));
  const visible = menu.slice(start, start + WINDOW);
  const nameW = Math.max(...menu.map(m => m.name.length));
  return (
    <Box flexDirection="column">
      {inputBox}
      <Box flexDirection="column" borderStyle="round" borderColor={theme.color.primary} paddingX={1}>
        <Text bold color={theme.color.primary}>{theme.icon.spark} commands {menu.length > WINDOW ? <Text dimColor>({menu.length})</Text> : null}</Text>
        {visible.map((cmd, i) => {
          const active = start + i === menuSel;
          return (
            <Text key={cmd.name} color={active ? theme.color.accent : undefined}>
              {active ? "❯ " : "  "}
              <Text color={active ? theme.color.accent : theme.color.fg}>/{cmd.name.padEnd(nameW)}</Text>
              <Text dimColor>  {cmd.description}</Text>
            </Text>
          );
        })}
        <Box marginTop={1}><Text dimColor>↑↓ move · tab complete · enter run · esc close</Text></Box>
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
          <Text color={theme.color.success} bold>a</Text><Text dimColor> approve & build   </Text>
          <Text color={theme.color.primary} bold>k</Text><Text dimColor> keep planning   </Text>
          <Text color={theme.color.error} bold>esc</Text><Text dimColor> cancel</Text>
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
          {cur === 0 ? "❯ " : "  "}{theme.icon.spark} new chat
        </Text>
        {sessions.slice(startRow, startRow + WINDOW).map((s, i) => {
          const realIdx = startRow + i + 1;
          const active = realIdx === cur;
          const isCurrent = s.id === activeId;
          return (
            <Text key={s.id} color={active ? theme.color.accent : theme.color.fg}>
              {active ? "❯ " : "  "}
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
              {active ? "❯ " : "  "}{mark}{e.isDir ? `${theme.icon.folder} ` : ""}{label}
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
