import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getConfig, saveConfig } from "../config";
import { systemPrompt, type Mode } from "../prompt";
import { chat, resetClient, estimateTokens, summarizeConversation, compactHistory, warmUp } from "../llm";
import { listOllamaModelsDetailed, modelHint, modelInfo } from "../ollama";
import { buildDiffView, type DiffView } from "../diff";
import { ThinkSplitter } from "../think";
import { isCommand, runCommand, commandList, type CommandContext } from "../commands";
import {
  saveSession, loadSession, latestSession, listSessions, deleteSession, newSessionId, deriveTitle,
  type SessionMeta,
} from "../session";
import { theme } from "./theme";
import {
  Banner, UserMessage, AssistantMessage, Thinking, ToolCard, SystemMessage,
  StatusBar, PermissionPrompt, SelectList, PlanApproval, PromptInput, FileBrowser, ChatBrowser,
  GeneratingLine, type ToolView, type StatusState,
} from "./components";
import { expandSelection, readFilesAsContext } from "../files";
import { learnProfileInstruction, profileFilePath, listProfileNames, setActiveProfile, getActiveProfileName } from "../profile";
import { stopAllServers } from "../proc";

type Item =
  | { id: number; kind: "banner"; model: string; baseUrl: string; cwd: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; tool: ToolView }
  | { id: number; kind: "system"; text: string; tone?: "info" | "error" };

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type ItemInput = DistributiveOmit<Item, "id">;

type Overlay =
  | { kind: "permission"; tool: string; detail: string; diff?: DiffView; resolve: (ok: boolean) => void }
  | { kind: "plan" }
  | { kind: "model"; models: string[]; hints: Record<string, string>; loading: boolean }
  | { kind: "chats"; sessions: SessionMeta[] }
  | { kind: "profiles"; names: string[] }
  | { kind: "choice"; question: string; options: string[]; resolve: (answer: string) => void }
  | { kind: "files" };

function summarize(name: string, argsJson: string): string {
  let a: any = {};
  try { a = JSON.parse(argsJson || "{}"); } catch {}
  switch (name) {
    case "read_file": case "write_file": case "edit_file": case "delete_file": return a.path ?? "";
    case "glob_files": return a.pattern ?? "";
    case "grep_files": return `"${a.pattern ?? ""}"${a.glob ? " in " + a.glob : ""}`;
    case "list_dir": return a.path ?? ".";
    case "bash": return a.command ?? "";
    case "run_server": return a.command ?? "";
    case "server_logs": return a.id ? `logs ${a.id}` : "logs (latest)";
    case "stop_server": return a.id ? `stop ${a.id}` : "stop (latest)";
    case "list_servers": return "";
    case "read_profile": return a.name ? a.name : "coding profile";
    case "update_profile": return a.name ? `→ ${a.name}` : "coding profile";
    case "ask_user": return a.question ?? "";
    default: return argsJson;
  }
}

function permDetail(name: string, args: any): string {
  if (name === "bash") return `$ ${args.command}`;
  if (name === "write_file") return `write ${args.path} (${args.content?.length ?? 0} chars)`;
  if (name === "edit_file") return `edit ${args.path}`;
  if (name === "delete_file") return `delete ${args.path}`;
  if (name === "run_server") return `▶ start server: ${args.command}`;
  if (name === "stop_server") return `stop server ${args.id ?? "(latest)"}`;
  if (name === "update_profile") return `save to coding profile${args.name ? ` "${args.name}"` : ""}:\n${(args.content ?? "").slice(0, 200)}`;
  return JSON.stringify(args);
}

// Build a before/after diff for the permission preview, where it makes sense.
function computeDiff(name: string, args: any, cwd: string): DiffView | undefined {
  try {
    if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
      return buildDiffView(args.old_string, args.new_string);
    }
    if (name === "write_file" && typeof args.content === "string") {
      const fp = resolve(cwd, args.path);
      const existing = existsSync(fp) && statSync(fp).isFile() ? readFileSync(fp, "utf-8") : "";
      return buildDiffView(existing, args.content);
    }
  } catch {
    /* fall through — no diff */
  }
  return undefined;
}

function expandMentions(input: string, cwd: string): string {
  const mentions = [...input.matchAll(/@(\S+)/g)].map(m => m[1]).filter((x): x is string => !!x);
  const blocks: string[] = [];
  for (const m of mentions) {
    const fp = resolve(cwd, m);
    if (existsSync(fp) && statSync(fp).isFile()) {
      try { blocks.push(`\n\n--- ${m} ---\n${readFileSync(fp, "utf-8")}\n--- end ${m} ---`); } catch {}
    }
  }
  return blocks.length ? input + blocks.join("") : input;
}

// Rebuild a pretty transcript from raw history when resuming a session.
function rebuildTranscript(history: ChatCompletionMessageParam[]): ItemInput[] {
  const items: ItemInput[] = [];
  const toolResult = new Map<string, string>();
  for (const m of history) {
    if (m.role === "tool") toolResult.set((m as any).tool_call_id, typeof m.content === "string" ? m.content : "");
  }
  for (const m of history) {
    if (m.role === "user") {
      let text = typeof m.content === "string" ? m.content : "";
      const cut = text.indexOf("\n\n--- ");
      if (cut !== -1) text = text.slice(0, cut) + "  (+attached files)";
      items.push({ kind: "user", text });
    } else if (m.role === "assistant") {
      const content = typeof m.content === "string" ? m.content : "";
      if (content.trim()) items.push({ kind: "assistant", text: content });
      for (const tc of (m as any).tool_calls ?? []) {
        const result = toolResult.get(tc.id) ?? "";
        items.push({
          kind: "tool",
          tool: {
            name: tc.function.name,
            summary: summarize(tc.function.name, tc.function.arguments),
            result,
            status: result.includes("denied") ? "denied" : "done",
          },
        });
      }
    }
  }
  return items;
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "banner": return <Banner model={item.model} baseUrl={item.baseUrl} cwd={item.cwd} />;
    case "user": return <UserMessage text={item.text} />;
    case "assistant": return <AssistantMessage text={item.text} />;
    case "thinking": return <Thinking text={item.text} />;
    case "tool": return <ToolCard tool={item.tool} />;
    case "system": return <SystemMessage text={item.text} tone={item.tone} />;
  }
}

interface AppProps { autoResume?: boolean }

export function App({ autoResume = false }: AppProps) {
  const { exit } = useApp();
  const cfg = getConfig();

  const [committed, setCommitted] = useState<Item[]>([
    { id: 0, kind: "banner", model: cfg.model, baseUrl: cfg.baseUrl, cwd: cfg.cwd },
  ]);
  const [status, setStatus] = useState<"idle" | "thinking">("idle");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [liveTool, setLiveTool] = useState<ToolView | null>(null);
  const [model, setModel] = useState(cfg.model);
  const [cwd, setCwd] = useState(cfg.cwd);
  const [tokens, setTokens] = useState(0);
  const [contextWindow, setContextWindow] = useState(cfg.contextWindow); // adapts per model
  const [usage, setUsage] = useState({ inTok: 0, outTok: 0, tps: 0 }); // session totals + last speed
  const [liveOut, setLiveOut] = useState(0);  // live output tokens for the in-flight turn
  const [elapsed, setElapsed] = useState(0);  // seconds the current turn has been running
  const [mode, setModeState] = useState<Mode>("normal");
  const [, force] = useReducer((x: number) => x + 1, 0);

  const historyRef = useRef<ChatCompletionMessageParam[]>([{ role: "system", content: systemPrompt({ mode: "normal" }) }]);
  const answerRef = useRef("");
  const thinkingRef = useRef("");
  const idRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionAllowRef = useRef<Set<string>>(new Set());
  const currentToolRef = useRef<{ name: string; summary: string } | null>(null);
  const modeRef = useRef<Mode>("normal");
  const turnHadAnswerRef = useRef(false);
  const sessionIdRef = useRef<string>(newSessionId());
  const createdAtRef = useRef<number>(Date.now());
  const inputHistoryRef = useRef<string[]>([]);

  const nextId = () => ++idRef.current;
  const commit = (item: ItemInput) => setCommitted(c => [...c, { ...item, id: nextId() } as Item]);
  const recomputeTokens = () => setTokens(estimateTokens(historyRef.current));

  // Keep the context window in step with the selected model's NATIVE limit.
  // On a model switch we set it to the model's native length; on startup we only
  // clamp DOWN if the saved value exceeds what the model actually supports (so a
  // 131k setting left over from another model doesn't give a wrong % or over-ask
  // num_ctx). A user's smaller custom value is respected.
  const syncContextForModel = async (m: string, opts: { force: boolean }) => {
    try {
      const info = await modelInfo(getConfig().baseUrl, m);
      const native = info?.contextLength;
      if (!native) return;
      const current = getConfig().contextWindow;
      const next = opts.force ? native : Math.min(current, native);
      if (next !== current) {
        saveConfig({ contextWindow: next });
        setContextWindow(next);
        if (opts.force) commit({ kind: "system", text: `Context window set to ${next.toLocaleString()} tokens for ${m} (its native limit).` });
      } else {
        setContextWindow(current);
      }
    } catch { /* model info unavailable — keep the current setting */ }
  };

  const flushActive = () => {
    if (thinkingRef.current.trim()) commit({ kind: "thinking", text: thinkingRef.current.trim() });
    if (answerRef.current.trim()) { commit({ kind: "assistant", text: answerRef.current }); turnHadAnswerRef.current = true; }
    thinkingRef.current = "";
    answerRef.current = "";
    force();
  };

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    // Refresh the system prompt so plan-mode instructions take effect next turn.
    historyRef.current[0] = { role: "system", content: systemPrompt({ mode: m }) };
  };

  // shift+tab cycles: normal → plan → auto-accept → normal.
  const cycleMode = () => {
    const order: Mode[] = ["normal", "plan", "auto"];
    const next = order[(order.indexOf(modeRef.current) + 1) % order.length]!;
    setMode(next);
  };

  const autosave = () => {
    if (historyRef.current.length <= 1) return;
    const c = getConfig();
    saveSession({
      id: sessionIdRef.current,
      title: deriveTitle(historyRef.current),
      model: c.model,
      cwd: c.cwd,
      createdAt: createdAtRef.current,
      updatedAt: Date.now(),
      history: historyRef.current,
    });
  };

  const resume = (id?: string) => {
    const c = getConfig();
    const sess = id ? loadSession(c.cwd, id) : latestSession(c.cwd);
    if (!sess) { commit({ kind: "system", text: "No saved session to resume for this folder.", tone: "error" }); return; }
    historyRef.current = sess.history;
    sessionIdRef.current = sess.id;
    createdAtRef.current = sess.createdAt;
    const items = rebuildTranscript(sess.history);
    setCommitted([
      { id: 0, kind: "banner", model: c.model, baseUrl: c.baseUrl, cwd: c.cwd },
      ...items.map(it => ({ ...it, id: nextId() } as Item)),
      { id: nextId(), kind: "system", text: `Resumed "${sess.title}" — ${sess.history.length} messages.` },
    ]);
    setUsage({ inTok: 0, outTok: 0, tps: 0 });
    recomputeTokens();
  };

  // Start a fresh chat, saving the current one first so it stays in history.
  const startNewChat = () => {
    autosave();
    historyRef.current = [{ role: "system", content: systemPrompt({ mode: modeRef.current }) }];
    const c = getConfig();
    sessionIdRef.current = newSessionId();
    createdAtRef.current = Date.now();
    setCommitted([{ id: 0, kind: "banner", model: c.model, baseUrl: c.baseUrl, cwd: c.cwd }]);
    setUsage({ inTok: 0, outTok: 0, tps: 0 });
    recomputeTokens();
  };

  // Switch to a saved chat (saving the current one first).
  const switchChat = (id: string) => { autosave(); setOverlay(null); resume(id); };

  const compact = async () => {
    if (historyRef.current.length <= 2) { commit({ kind: "system", text: "Nothing to compact yet." }); return; }
    setStatus("thinking");
    commit({ kind: "system", text: "Compacting conversation…" });
    try {
      const before = estimateTokens(historyRef.current);
      const summary = await summarizeConversation(historyRef.current);
      historyRef.current = compactHistory(historyRef.current, summary);
      const after = estimateTokens(historyRef.current);
      commit({ kind: "system", text: `Compacted — saved ~${(before - after).toLocaleString()} tokens (now ~${after.toLocaleString()}).` });
      recomputeTokens();
      autosave();
    } catch (e: any) {
      commit({ kind: "system", text: `Compaction failed: ${e.message}`, tone: "error" });
    } finally {
      setStatus("idle");
    }
  };

  const maybeAutoCompact = async () => {
    const c = getConfig();
    if (c.autoCompact && estimateTokens(historyRef.current) > c.contextWindow * 0.8) {
      await compact();
    }
  };

  // Run the agent on a canned instruction (used by /init and /learn).
  const runAgentTask = (display: string, instruction: string) => {
    commit({ kind: "user", text: display });
    historyRef.current.push({ role: "user", content: instruction });
    void runTurn();
  };

  const runInit = () => {
    runAgentTask(
      "/init — generating project context",
      "Explore this project — read package.json / manifests, scan the directory structure, and read the key entry files. " +
        "Then create a concise LOCALCLI.md at the project root using write_file, summarizing: what the project is, how to run/build/test it, " +
        "the directory layout, the most important files, and the coding conventions. Keep it under ~60 lines."
    );
  };

  const learnProfile = (name?: string) => {
    const profName = name || getActiveProfileName() || "default";
    setActiveProfile(profName); // use this profile from now on
    runAgentTask(
      `/learn — learning your "${profName}" coding style from this project`,
      learnProfileInstruction(profileFilePath(profName), profName)
    );
  };

  const openProfilePicker = () => {
    const names = listProfileNames();
    if (names.length === 0) {
      commit({ kind: "system", text: "No profiles yet. Run /learn <name> in a project to create one (e.g. /learn web)." });
      return;
    }
    setOverlay({ kind: "profiles", names });
  };

  // Global keys: shift+tab toggles plan mode, esc interrupts.
  useInput((_in, key) => {
    if (overlay) return; // overlays own their keys
    if (key.tab && key.shift) { cycleMode(); return; }
    if (key.escape && status === "thinking" && abortRef.current) abortRef.current.abort();
  });

  const runTurn = async () => {
    setStatus("thinking");
    setLiveOut(0);
    turnHadAnswerRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const splitter = new ThinkSplitter();

    const writeSeg = (chunk: string | null) => {
      const segs = chunk === null ? splitter.flush() : splitter.push(chunk);
      for (const s of segs) {
        if (!s.text) continue;
        if (s.think) thinkingRef.current += s.text;
        else answerRef.current += s.text;
      }
      force();
    };

    let retries = 0;
    while (retries < 2) {
      if (ac.signal.aborted) break;
      try {
        historyRef.current = await chat(
          historyRef.current,
          {
            onText: (c) => writeSeg(c),
            onToolCall: (name, argsJson) => {
              writeSeg(null);
              flushActive();
              const summary = summarize(name, argsJson);
              currentToolRef.current = { name, summary };
              setLiveTool({ name, summary, status: "running" });
            },
            onToolResult: (name, result) => {
              const summary = currentToolRef.current?.summary ?? "";
              setLiveTool(null);
              commit({
                kind: "tool",
                tool: { name, summary, result, status: result.includes("denied by user") ? "denied" : "done" },
              });
            },
            onError: (e) => commit({ kind: "system", text: e.message, tone: "error" }),
            onNotice: (msg) => commit({ kind: "system", text: msg }),
            onUsage: (u) => setUsage(prev => ({ inTok: prev.inTok + u.inputTokens, outTok: prev.outTok + u.outputTokens, tps: u.tokPerSec || prev.tps })),
            onProgress: (t) => setLiveOut(t),
            requestPermission: async (name, args) => {
              if (sessionAllowRef.current.has(name)) return true;
              return new Promise<boolean>((res) => {
                setOverlay({
                  kind: "permission",
                  tool: name,
                  detail: permDetail(name, args),
                  diff: computeDiff(name, args, getConfig().cwd),
                  resolve: res,
                });
              });
            },
            requestChoice: async (question, opts) => {
              return new Promise<string>((res) => {
                setOverlay({ kind: "choice", question, options: opts, resolve: res });
              });
            },
          },
          { signal: ac.signal, planMode: modeRef.current === "plan", autoAccept: modeRef.current === "auto" }
        );

        // Check if we got a response (i.e. assistant message was pushed to history)
        const lastMsg = historyRef.current[historyRef.current.length - 1];
        const gotResponse = lastMsg && lastMsg.role === "assistant";
        if (gotResponse || ac.signal.aborted) {
          break;
        }

        // No response returned (empty response). Attempt auto-compaction.
        if (historyRef.current.length > 2) {
          commit({ kind: "system", text: "The model returned an empty response. Automatically compacting conversation history to free up context..." });
          const before = estimateTokens(historyRef.current);
          const summary = await summarizeConversation(historyRef.current);
          historyRef.current = compactHistory(historyRef.current, summary);
          const after = estimateTokens(historyRef.current);
          commit({ kind: "system", text: `Compacted — saved ~${(before - after).toLocaleString()} tokens (now ~${after.toLocaleString()}). Retrying turn...` });
          recomputeTokens();
          autosave();
          retries++;
        } else {
          break; // cannot compact further
        }
      } catch (e: any) {
        commit({ kind: "system", text: `Fatal error: ${e.message}`, tone: "error" });
        break;
      }
    }
    writeSeg(null);
    flushActive();
    abortRef.current = null;
    setStatus("idle");
    recomputeTokens();

    // After a plan-mode turn that produced a plan, offer to approve it.
    if (modeRef.current === "plan" && turnHadAnswerRef.current) {
      setOverlay({ kind: "plan" });
    }
  };

  const decidePermission = (d: "yes" | "no" | "always") => {
    if (overlay?.kind !== "permission") return;
    if (d === "always") sessionAllowRef.current.add(overlay.tool);
    overlay.resolve(d !== "no");
    setOverlay(null);
  };

  const decidePlan = (d: "approve" | "keep" | "cancel") => {
    setOverlay(null);
    if (d === "approve") {
      setMode("normal");
      historyRef.current.push({ role: "user", content: "The plan is approved. Implement it now, making the changes." });
      commit({ kind: "system", text: "Plan approved — switching to normal mode and implementing." });
      void runTurn().then(autosave);
    }
    // keep / cancel → stay in plan mode, return to input
  };

  // Read selected files/folders and stage them into context as a user message.
  const addPaths = (rawPaths: string[]) => {
    const cwd = getConfig().cwd;
    const abs = rawPaths.map(p => resolve(cwd, p));
    const files = expandSelection(abs);
    if (files.length === 0) { commit({ kind: "system", text: "No readable files selected.", tone: "error" }); return; }
    const { block, included, skipped, truncated } = readFilesAsContext(files, cwd);
    if (!included.length) { commit({ kind: "system", text: "Nothing readable to add (binary/too large).", tone: "error" }); return; }
    historyRef.current.push({ role: "user", content: `I'm attaching these files for context. Read them; you don't need to re-read them with tools:\n\n${block}` });
    recomputeTokens();
    autosave();
    commit({
      kind: "system",
      text: `Added ${included.length} file(s) to context` +
        (skipped ? `, skipped ${skipped}` : "") + (truncated ? " (hit size cap)" : "") + ":\n" +
        included.map(f => `  + ${f}`).join("\n"),
    });
  };

  const buildCtx = (): CommandContext => ({
    history: historyRef.current,
    print: (text, tone) => commit({ kind: "system", text, tone }),
    clearHistory: startNewChat,
    exit: () => { autosave(); stopAllServers(); exit(); },
    mode: modeRef.current,
    setMode,
    compact,
    saveSession: autosave,
    resume,
    openModelPicker: () => {
      const c = getConfig();
      // Show whatever Ollama actually has installed (`ollama list`). The config
      // list is only a fallback for when Ollama isn't reachable; we don't persist
      // or merge it, so it can't drift from reality.
      setOverlay({ kind: "model", models: c.models, hints: {}, loading: true });
      listOllamaModelsDetailed(c.baseUrl)
        .then(live => setOverlay(o => {
          if (o?.kind !== "model") return o;
          const names = live.length ? live.map(m => m.name) : c.models;
          const hints: Record<string, string> = {};
          for (const m of live) hints[m.name] = modelHint(m);
          return { kind: "model", models: names, hints, loading: false };
        }))
        .catch(() => setOverlay(o => (o?.kind === "model" ? { ...o, loading: false } : o)));
    },
    openSessionPicker: () => setOverlay({ kind: "chats", sessions: listSessions(getConfig().cwd) }),
    openFiles: () => setOverlay({ kind: "files" }),
    addPaths,
    runInit,
    learnProfile,
    openProfilePicker,
  });

  const onSubmit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;

    if (isCommand(value)) {
      const prevModel = getConfig().model;
      await runCommand(value, buildCtx());
      const c = getConfig();
      if (c.model !== prevModel) { setModel(c.model); void syncContextForModel(c.model, { force: true }); }
      setCwd(c.cwd);
      return;
    }

    commit({ kind: "user", text: value });
    historyRef.current.push({ role: "user", content: expandMentions(value, getConfig().cwd) });
    await runTurn();
    autosave();
    await maybeAutoCompact();
  };

  // Optionally resume the most recent session on launch (--continue), and warm
  // the model so the first message doesn't wait on a cold load.
  useEffect(() => {
    if (autoResume) resume();
    void warmUp();
    void syncContextForModel(getConfig().model, { force: false });
    // Best-effort: don't leave background servers running if the process dies.
    const cleanup = () => stopAllServers();
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    return () => {
      process.off("exit", cleanup);
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick an elapsed-seconds clock while a turn runs, so the UI shows it's alive
  // even before the first token arrives (cold loads can take many seconds).
  useEffect(() => {
    if (status !== "thinking") { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(id);
  }, [status]);

  const activeThinking = thinkingRef.current;
  const activeAnswer = answerRef.current;
  const statusForBar: StatusState = overlay?.kind === "permission" ? "permission" : status;

  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>

      {activeThinking ? <Thinking text={activeThinking} live /> : null}
      {activeAnswer ? <AssistantMessage text={activeAnswer} live /> : null}
      {liveTool ? <ToolCard tool={liveTool} /> : null}

      <Box flexDirection="column" marginTop={1}>
        <StatusBar
          model={model}
          tokens={tokens}
          contextWindow={contextWindow}
          status={statusForBar}
          mode={mode}
        />
        {overlay?.kind === "permission" ? (
          <PermissionPrompt name={overlay.tool} detail={overlay.detail} diff={overlay.diff} onDecide={decidePermission} />
        ) : overlay?.kind === "plan" ? (
          <PlanApproval onDecide={decidePlan} />
        ) : overlay?.kind === "model" ? (
          <SelectList
            title={overlay.loading ? "Select a model (loading installed…)" : "Select a model"}
            items={overlay.models.map(m => {
              const spec = overlay.hints[m] ?? "";
              const cur = m === model ? "● current" : "";
              return { label: m, value: m, hint: [cur, spec].filter(Boolean).join("   ") };
            })}
            onSelect={(m) => { saveConfig({ model: m }); resetClient(); setModel(m); setOverlay(null); commit({ kind: "system", text: `Model set to ${m}` }); void syncContextForModel(m, { force: true }); }}
            onCancel={() => setOverlay(null)}
          />
        ) : overlay?.kind === "chats" ? (
          <ChatBrowser
            sessions={overlay.sessions}
            activeId={sessionIdRef.current}
            onSwitch={switchChat}
            onNew={() => { setOverlay(null); startNewChat(); }}
            onDelete={(id) => { deleteSession(getConfig().cwd, id); setOverlay({ kind: "chats", sessions: listSessions(getConfig().cwd) }); }}
            onCancel={() => setOverlay(null)}
          />
        ) : overlay?.kind === "files" ? (
          <FileBrowser
            startDir={getConfig().cwd}
            onConfirm={(paths) => { setOverlay(null); addPaths(paths); }}
            onCancel={() => setOverlay(null)}
          />
        ) : overlay?.kind === "profiles" ? (
          <SelectList
            title="Select the active coding profile"
            items={overlay.names.map(n => ({ label: n, value: n, hint: n === getActiveProfileName() ? "● active" : "" }))}
            onSelect={(n) => { setActiveProfile(n); setOverlay(null); commit({ kind: "system", text: `Active coding profile: ${n}. I'll follow it in every project.` }); }}
            onCancel={() => setOverlay(null)}
          />
        ) : overlay?.kind === "choice" ? (
          <SelectList
            title={overlay.question}
            items={overlay.options.map(o => ({ label: o, value: o }))}
            onSelect={(answer) => { const r = overlay.resolve; setOverlay(null); commit({ kind: "system", text: `${overlay.question}  →  ${answer}` }); r(answer); }}
            onCancel={() => { const r = overlay.resolve; const first = overlay.options[0] ?? ""; setOverlay(null); r(first); }}
          />
        ) : status === "idle" ? (
          <PromptInput
            color={mode === "plan" ? theme.color.accent : mode === "auto" ? theme.color.warn : theme.color.user}
            placeholder={mode === "plan" ? "describe what to plan…" : mode === "auto" ? "auto-accept on — message…" : "message, or /help…  (↑ history · Ctrl+V paste)"}
            onSubmit={onSubmit}
            history={inputHistoryRef}
            commands={commandList()}
          />
        ) : (
          <GeneratingLine tokens={liveOut} elapsed={elapsed} />
        )}
      </Box>
    </Box>
  );
}
