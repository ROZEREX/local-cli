// Web UI server — a full browser front end for local-cli, powered by the SAME
// agent core as the terminal (src/llm.ts, tools, config, sessions, profiles,
// servers…). It serves a Tailwind single-page app and bridges it to chat() over a
// WebSocket, plus REST endpoints for models / sessions / folders / profiles.
// The terminal CLI is untouched. Run with:  bun run web
import { join, relative, resolve } from "path";
import { existsSync, statSync } from "fs";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { ServerWebSocket } from "bun";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  chat, estimateTokens, resetClient, warmUp, summarizeConversation, compactHistory,
} from "../src/llm";
import { getConfig, saveConfig, resetConfigCache } from "../src/config";
import {
  isIncognito, setIncognito, incognitoState, remoteBackendWarning,
  SUPPRESSED, NOT_PROTECTED,
} from "../src/incognito";
import { systemPrompt, type Mode } from "../src/prompt";
import { ThinkSplitter } from "../src/think";
import { listOllamaModelsDetailed, modelInfo, loadedModels, modelCapabilities, modelDiskSize } from "../src/ollama";
import { analyzeImage } from "../src/vision";
import {
  saveSession, listSessions, deleteSession, loadSession, newSessionId, deriveTitle, type Session,
} from "../src/session";
import {
  listProfileNames, getActiveProfileName, readProfileByName, readActiveProfile, setActiveProfile,
  deleteProfileByName, learnProfileInstruction, profileFilePath, availablePackageManagers,
} from "../src/profile";
import { listServers, serverLogs, stopServer } from "../src/proc";
import { listListeningPorts, killPort } from "../src/ports";
import { systemInfo, recommendModels, modelFitWarning } from "../src/sysinfo";
import {
  listDirEntries, expandSelection, readFilesAsContext,
  isRootDir, listDrives, normalizeBrowsePath,
} from "../src/files";
import {
  browserOpen, browserReadText, browserClose, browserScreenshot, evalJs,
  browserStartScreencast, browserStopScreencast, browserIsOpen,
} from "../src/browser";
import { setExtension, resolveCommand, extensionConnected } from "../src/extbridge";
import { closePrivateChrome } from "../src/web-search";
import { commandList, runCommand } from "../src/commands/index";
import { resolveWorkspacePath } from "../src/tools/executor";

const PUBLIC = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 4317);
const BOOT_TOKEN = randomBytes(32).toString("base64url");
const CLIENT_STATE_TTL_MS = 30 * 60_000;

type PendingRequest =
  | { kind: "permission"; tool: string; callId?: string; resolve: (v: boolean) => void }
  | { kind: "choice"; options: string[]; resolve: (v: string) => void }
  | { kind: "plan"; resolve: (v: "approve" | "keep" | "reject") => void };

interface WSData {
  kind: "ui" | "ext";
  clientId: string;
  connected: boolean;
  resumed: boolean;
  history: ChatCompletionMessageParam[];
  mode: Mode;
  busy: boolean;
  abort: AbortController | null;
  pending: Map<number, PendingRequest>;
  seq: number;
  sessionId: string;
  createdAt: number;
  stateVersion: number;
  activeRunId: string | null;
  runSeq: number;
  toolSeq: number;
  toolQueues: Map<string, string[]>;
  toolStartedAt: Map<string, number>;
  // Fingerprint of the inputs that shape the system prompt (see runChat).
  sysFp?: string;
}

const send = (ws: ServerWebSocket<WSData>, obj: any): boolean => {
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
};

const retainedClients = new Map<string, { data: WSData; expiresAt: number }>();
let activeRuns = 0;
let extensionClient: ServerWebSocket<WSData> | null = null;

function safeClientId(raw: string | null): string {
  return raw && /^[a-zA-Z0-9_-]{16,128}$/.test(raw) ? raw : randomUUID();
}

function newWSData(kind: "ui" | "ext", clientId: string, mode: Mode): WSData {
  return {
    kind, clientId, connected: false, resumed: false,
    history: freshHistory(mode), mode, busy: false, abort: null,
    pending: new Map(), seq: 0, sessionId: newSessionId(), createdAt: Date.now(),
    stateVersion: 0, activeRunId: null, runSeq: 0, toolSeq: 0,
    toolQueues: new Map(), toolStartedAt: new Map(),
  };
}

function pruneRetainedClients(now = Date.now()) {
  for (const [id, saved] of retainedClients) if (saved.expiresAt <= now) retainedClients.delete(id);
}

function resumeOrCreateClient(clientId: string, mode: Mode): WSData {
  pruneRetainedClients();
  const saved = retainedClients.get(clientId);
  if (!saved || saved.data.connected) return newWSData("ui", clientId, mode);
  retainedClients.delete(clientId);
  const data = saved.data;
  data.resumed = true;
  data.busy = false;
  data.abort = null;
  data.pending = new Map();
  data.activeRunId = null;
  data.runSeq = 0;
  data.toolSeq = 0;
  data.toolQueues = new Map();
  data.toolStartedAt = new Map();
  return data;
}

function tokenMatches(value: string | null): boolean {
  if (!value) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(BOOT_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function allowedSocketOrigin(req: Request, url: URL, kind: "ui" | "ext"): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  if (kind === "ext") return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isLoopbackHost(parsed.hostname)
      && parsed.port === url.port;
  } catch { return false; }
}

function securityHeaders(contentType?: string): Record<string, string> {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function runEvent(ws: ServerWebSocket<WSData>, runId: string, t: string, payload: Record<string, any> = {}) {
  if (ws.data.activeRunId !== runId) return;
  send(ws, { t, runId, seq: ++ws.data.runSeq, at: Date.now(), ...payload });
}

function beginTool(ws: ServerWebSocket<WSData>, name: string, preferredId?: string): string {
  const id = preferredId || `${ws.data.activeRunId}:tool:${++ws.data.toolSeq}`;
  const queue = ws.data.toolQueues.get(name) ?? [];
  queue.push(id);
  ws.data.toolQueues.set(name, queue);
  ws.data.toolStartedAt.set(id, Date.now());
  return id;
}

function finishTool(ws: ServerWebSocket<WSData>, name: string, preferredId?: string, preferredDuration?: number): { id: string; durationMs: number } {
  const queue = ws.data.toolQueues.get(name) ?? [];
  const preferredIndex = preferredId ? queue.indexOf(preferredId) : -1;
  const id = preferredIndex >= 0 ? queue.splice(preferredIndex, 1)[0]! : (queue.shift() ?? preferredId ?? `${ws.data.activeRunId}:tool:unknown`);
  if (queue.length) ws.data.toolQueues.set(name, queue); else ws.data.toolQueues.delete(name);
  const started = ws.data.toolStartedAt.get(id) ?? Date.now();
  ws.data.toolStartedAt.delete(id);
  return { id, durationMs: preferredDuration ?? Math.max(0, Date.now() - started) };
}

function settlePending(data: WSData) {
  for (const pending of data.pending.values()) {
    if (pending.kind === "permission") pending.resolve(false);
    else if (pending.kind === "choice") pending.resolve("");
    else pending.resolve("keep");
  }
  data.pending.clear();
}

function freshSystem(mode: Mode): ChatCompletionMessageParam { return { role: "system", content: systemPrompt({ mode }) }; }
function freshHistory(mode: Mode): ChatCompletionMessageParam[] { return [freshSystem(mode)]; }

// Inputs that genuinely require a new system prompt. Rebuilding it on EVERY
// turn (as we used to) embedded the live ports/servers list, which changes
// between turns — and any change to the prompt prefix invalidates Ollama's
// prompt cache, forcing a full re-prefill of the whole conversation each turn.
// That made the web UI noticeably slower than the CLI. Now we rebuild only
// when one of these actually changes.
function systemFingerprint(mode: Mode): string {
  const cfg = getConfig();
  return [
    mode, cfg.model, cfg.cwd, cfg.packageManager,
    getActiveProfileName() ?? "", (readActiveProfile() ?? "").length,
    extensionConnected() ? "ext" : "",
    isIncognito() ? "incognito" : "",
  ].join("|");
}

function configPayload() {
  const cfg = getConfig();
  let localBackend = true;
  try { localBackend = isLoopbackHost(new URL(cfg.baseUrl).hostname); } catch {}
  return {
    model: cfg.model, cwd: cfg.cwd, contextWindow: cfg.contextWindow, baseUrl: cfg.baseUrl,
    thinking: cfg.thinking !== false, packageManager: cfg.packageManager,
    activeProfile: getActiveProfileName(), profiles: listProfileNames(),
    availablePM: availablePackageManagers(), mode: cfg.mode ?? "normal",
    extConnected: extensionConnected(),
    keepAlive: cfg.keepAlive ?? "(ollama default, 5m)", numGpu: cfg.numGpu ?? null, numThread: cfg.numThread ?? null,
    maxTokens: cfg.maxTokens, temperature: cfg.temperature,
    incognito: incognitoState(),
    // "Nothing leaves the machine" is only true when the backend is on it.
    backendWarning: remoteBackendWarning(cfg.baseUrl),
    reasoningSource: localBackend ? "local_model_trace" : "provider_reasoning_summary",
    suppressed: SUPPRESSED, notProtected: NOT_PROTECTED,
  };
}

// Track web-UI sockets so we can tell them when the browser extension connects.
const uiClients = new Set<ServerWebSocket<WSData>>();
function broadcastConfig() { const p = { t: "config", config: configPayload() }; for (const c of uiClients) { try { c.send(JSON.stringify(p)); } catch {} } }

// ── live browser view ──────────────────────────────────────────────────────
// While the agent drives the controlled browser, stream CDP screencast frames
// to every web-UI client so the user WATCHES the AI cursor click and type live
// (instead of only seeing a stale screenshot after each action). Throttled to
// ~4 fps — plenty for watching, light on the socket.
let manualLive = false; // the user toggled live view on from the Browser tab
let lastFrameAt = 0;
function broadcastFrame(data: string) {
  const now = Date.now();
  if (now - lastFrameAt < 250) return;
  lastFrameAt = now;
  const p = JSON.stringify({ t: "browser_frame", data });
  for (const c of uiClients) { try { c.send(p); } catch {} }
}
async function startLiveView(): Promise<boolean> {
  if (!browserIsOpen()) return false;
  try { await browserStartScreencast(broadcastFrame); return true; } catch { return false; }
}

function summarize(name: string, argsJson: string): string {
  let a: any = {};
  try { a = JSON.parse(argsJson || "{}"); } catch {}
  switch (name) {
    case "read_file": case "write_file": case "edit_file": case "delete_file": return a.path ?? "";
    case "glob_files": return a.pattern ?? "";
    case "grep_files": return `"${a.pattern ?? ""}"${a.glob ? " in " + a.glob : ""}`;
    case "list_dir": return a.path ?? ".";
    case "bash": case "run_server": return a.command ?? "";
    case "server_logs": case "stop_server": return a.id ?? "(latest)";
    case "update_profile": case "read_profile": return a.name ?? "coding profile";
    case "ask_user": return a.question ?? "";
    case "kill_port": return a.port ? ":" + a.port : "";
    case "browser_open": return a.url ?? "";
    case "browser_click": return a.target ?? a.selector ?? a.text ?? "";
    case "browser_type": return `${a.target ?? a.selector ?? ""}: "${a.text ?? ""}"`;
    case "browser_screenshot": case "screenshot": return a.question ?? "";
    case "generate_image": return a.prompt ?? "";
    case "browser_scroll": case "page_scroll": return a.to ?? "down";
    case "page_open": case "page_navigate": return a.url ?? "";
    case "page_click": case "page_highlight": return a.target ?? "";
    case "page_find": return a.query ?? "";
    case "page_type": return `${a.target ?? ""}: "${a.text ?? ""}"`;
    default: return "";
  }
}
function permDetail(name: string, a: any): string {
  if (name === "bash" || name === "run_server") return `$ ${a.command}`;
  if (name === "write_file") return `write ${a.path} (${a.content?.length ?? 0} chars)`;
  if (name === "edit_file") return `edit ${a.path}`;
  if (name === "delete_file") return `delete ${a.path}`;
  if (name === "update_profile") return `save to coding profile`;
  if (name === "generate_image") return `generate an image: "${a.prompt}"${a.path ? ` → ${a.path}` : ""}`;
  if (name === "browser_type" || name === "page_type") return `type "${a.text}" into ${a.target}`;
  return JSON.stringify(a);
}

function pushContext(ws: ServerWebSocket<WSData>) {
  send(ws, { t: "context", used: estimateTokens(ws.data.history), limit: getConfig().contextWindow });
}
function pushConfig(ws: ServerWebSocket<WSData>) { send(ws, { t: "config", config: configPayload() }); }

function autosave(ws: ServerWebSocket<WSData>) {
  // saveSession() also refuses in incognito, but returning here keeps us from
  // even building the record — and from re-sending a chat list this session
  // will never appear in.
  if (isIncognito()) return;
  const hist = ws.data.history;
  if (!hist.some(m => m.role === "user")) return;
  const cfg = getConfig();
  const session: Session = {
    id: ws.data.sessionId, title: deriveTitle(hist), model: cfg.model, cwd: cfg.cwd,
    createdAt: ws.data.createdAt, updatedAt: Date.now(), history: hist,
  };
  try { saveSession(session); } catch {}
  send(ws, { t: "sessions", list: listSessions(cfg.cwd), active: ws.data.sessionId });
}

// Run one agent turn over the current history, streaming everything to the client.
async function runChat(ws: ServerWebSocket<WSData>, userText: string, echo = true, images: string[] = []) {
  if (ws.data.busy) return;
  const runId = randomUUID();
  const runVersion = ws.data.stateVersion;
  const startedAt = Date.now();
  let outcome: "completed" | "cancelled" | "error" = "completed";
  let lastOutputKind: "reasoning" | "answer" | null = null;
  let toolCount = 0;
  let usage: any = null;

  ws.data.busy = true;
  ws.data.abort = new AbortController();
  ws.data.activeRunId = runId;
  ws.data.runSeq = 0;
  ws.data.toolSeq = 0;
  ws.data.toolQueues.clear();
  ws.data.toolStartedAt.clear();
  activeRuns++;
  runEvent(ws, runId, "run_start", {
    sessionId: ws.data.sessionId, mode: ws.data.mode,
    model: getConfig().model, cwd: getConfig().cwd,
  });
  if (echo) runEvent(ws, runId, "user", { text: userText, images });

  // Refresh the system prompt only when its real inputs change. Keeping the
  // prefix stable lets local backends reuse their prompt cache.
  const fp = systemFingerprint(ws.data.mode);
  if (ws.data.sysFp !== fp) { ws.data.history[0] = freshSystem(ws.data.mode); ws.data.sysFp = fp; }

  // Pasted images: send directly to a vision model, otherwise describe them
  // locally and attach that description to the prompt.
  if (images.length) {
    const cfg = getConfig();
    const caps = await modelCapabilities(cfg.baseUrl, cfg.model).catch(() => [] as string[]);
    if (caps.includes("vision")) {
      ws.data.history.push({ role: "user", content: userText, images } as any);
    } else {
      runEvent(ws, runId, "notice", { v: `"${cfg.model}" can't see images — describing them with a vision model instead.` });
      let combined = userText;
      for (let i = 0; i < images.length; i++) {
        const desc = await analyzeImage(images[i]!, "Describe this image in detail (visible text, UI elements, layout, errors) for an agent that cannot see it.");
        combined += `\n\n[Attached image ${i + 1}, described by a vision model]:\n${desc}`;
      }
      ws.data.history.push({ role: "user", content: combined });
    }
  } else {
    ws.data.history.push({ role: "user", content: userText });
  }

  const splitter = new ThinkSplitter();
  const emitText = (chunk: string | null) => {
    for (const s of (chunk === null ? splitter.flush() : splitter.push(chunk))) {
      if (!s.text) continue;
      const outputKind = s.think ? "reasoning" : "answer";
      if (lastOutputKind !== outputKind) {
        lastOutputKind = outputKind;
        runEvent(ws, runId, "phase", { phase: outputKind });
      }
      runEvent(ws, runId, "text", { v: s.text, think: s.think });
    }
  };

  try {
    const nextHistory = await chat(
      ws.data.history,
      {
        onText: (c) => emitText(c),
        onToolCallProgress: (name, args, meta) => runEvent(ws, runId, "tool_progress", {
          toolId: meta?.callId, name, phase: meta?.phase, durationMs: meta?.durationMs,
          args: String(args ?? "").slice(-4_000),
        }),
        onToolCall: (name, args, meta) => {
          const toolId = beginTool(ws, name, meta?.callId);
          toolCount++;
          runEvent(ws, runId, "tool_call", {
            toolId, name, phase: meta?.phase, summary: summarize(name, args), args: String(args ?? "").slice(0, 12_000),
          });
        },
        onToolResult: async (name, result, meta) => {
          const tool = finishTool(ws, name, meta?.callId, meta?.durationMs);
          runEvent(ws, runId, "tool_result", { toolId: tool.id, name, phase: meta?.phase, result, durationMs: tool.durationMs });
          if (name === "generate_image") {
            const mPath = result.match(/saved it to (.+?)\.\s/);
            if (mPath?.[1]) {
              try {
                const abs = resolve(getConfig().cwd, mPath[1]);
                const file = Bun.file(abs);
                if (await file.exists()) {
                  runEvent(ws, runId, "image", { path: mPath[1], data: Buffer.from(await file.arrayBuffer()).toString("base64") });
                }
              } catch {}
            }
          }
          if (name.startsWith("browser_") && name !== "browser_close") {
            void startLiveView();
            try {
              const text = await browserReadText().catch(() => "");
              const screenshot = await browserScreenshot().catch(() => "");
              const url = await evalJs("document.location.href").catch(() => "");
              const title = await evalJs("document.title").catch(() => "");
              runEvent(ws, runId, "browser_state", { url, title, text, screenshot });
            } catch {}
          }
        },
        onError: (e) => { outcome = "error"; runEvent(ws, runId, "error", { v: e.message }); },
        onNotice: (v) => runEvent(ws, runId, "notice", { v }),
        onHeartbeat: (message, info) => runEvent(ws, runId, "heartbeat", { message, ...info }),
        onStatus: (phase) => runEvent(ws, runId, "phase", { phase }),
        onUsage: (u) => {
          usage = u;
          runEvent(ws, runId, "usage", { inTok: u.inputTokens, outTok: u.outputTokens, tps: u.tokPerSec });
        },
        onLoopWarning: (info) => runEvent(ws, runId, "loop_warning", info),
        onProgress: (tok) => runEvent(ws, runId, "progress", { tok }),
        requestPermission: (name, args, meta) => new Promise<boolean>((res) => {
          const id = ++ws.data.seq;
          ws.data.pending.set(id, { kind: "permission", tool: name, callId: meta?.callId, resolve: res });
          runEvent(ws, runId, "permission", { id, callId: meta?.callId, tool: name, detail: permDetail(name, args) });
        }),
        requestChoice: (question, options) => new Promise<string>((res) => {
          const id = ++ws.data.seq;
          ws.data.pending.set(id, { kind: "choice", options: [...options], resolve: res });
          runEvent(ws, runId, "choice", { id, question, options });
        }),
        requestPlanApproval: (plan) => new Promise<"approve" | "keep" | "reject">((res) => {
          const id = ++ws.data.seq;
          ws.data.pending.set(id, { kind: "plan", resolve: res });
          runEvent(ws, runId, "plan_approval", { id, plan });
        }),
      },
      {
        signal: ws.data.abort.signal,
        planMode: ws.data.mode === "plan",
        chatMode: ws.data.mode === "chat",
        autoAccept: ws.data.mode === "auto",
      }
    );
    emitText(null);
    if (ws.data.abort?.signal.aborted) outcome = "cancelled";
    if (ws.data.stateVersion === runVersion && ws.data.activeRunId === runId) ws.data.history = nextHistory;
  } catch (e: any) {
    const aborted = ws.data.abort?.signal.aborted || /abort|cancel/i.test(String(e?.name ?? e?.message ?? e));
    outcome = aborted ? "cancelled" : "error";
    if (!aborted) runEvent(ws, runId, "error", { v: String(e?.message ?? e) });
  } finally {
    const stillCurrent = ws.data.activeRunId === runId;
    if (stillCurrent) {
      runEvent(ws, runId, "run_end", {
        outcome, durationMs: Math.max(0, Date.now() - startedAt), toolCount,
        usage: usage ? { inTok: usage.inputTokens, outTok: usage.outputTokens, tps: usage.tokPerSec } : null,
        mode: ws.data.mode,
      });
      ws.data.activeRunId = null;
      ws.data.busy = false;
      ws.data.abort = null;
    }
    settlePending(ws.data);
    activeRuns = Math.max(0, activeRuns - 1);
    if (!manualLive && activeRuns === 0) void browserStopScreencast();
    if (stillCurrent && ws.data.stateVersion === runVersion) {
      pushContext(ws);
      autosave(ws);
    }
  }
}

function newChat(ws: ServerWebSocket<WSData>) {
  ws.data.stateVersion++;
  ws.data.history = freshHistory(ws.data.mode);
  ws.data.sessionId = newSessionId();
  ws.data.createdAt = Date.now();
  send(ws, { t: "cleared" });
  pushContext(ws);
}

function blockStateChange(ws: ServerWebSocket<WSData>, action: string, global = false): boolean {
  if (!ws.data.busy && (!global || activeRuns === 0)) return false;
  send(ws, { t: "error", v: `Stop the active run before ${action}. This keeps the run's model, folder, and session state consistent.` });
  pushConfig(ws);
  send(ws, { t: "mode", mode: ws.data.mode });
  return true;
}

function addContextPaths(ws: ServerWebSocket<WSData>, paths: string[]): string {
  const safe: string[] = [];
  for (const path of paths.slice(0, 100)) {
    try { safe.push(resolveWorkspacePath(String(path))); }
    catch { /* Report the aggregate result below without exposing other paths. */ }
  }
  const files = expandSelection(safe, getConfig().cwd);
  const res = readFilesAsContext(files, getConfig().cwd);
  if (!res.included.length) return "No readable files inside the active workspace were selected.";
  ws.data.history.push({ role: "user", content: `I'm attaching these files for context:\n\n${res.block}` });
  pushContext(ws); autosave(ws);
  return `Added ${res.included.length} file(s) to context: ${res.included.join(", ")}${res.skipped ? ` (${res.skipped} skipped)` : ""}`;
}

async function runSlashCommand(ws: ServerWebSocket<WSData>, input: string) {
  if (blockStateChange(ws, "running a slash command", true)) return;
  const print = (text: string, tone: "info" | "error" = "info") => send(ws, { t: tone === "error" ? "error" : "notice", v: text });
  const loadById = (id?: string) => {
    if (isIncognito()) { print("Saved chats cannot be opened while incognito is on.", "error"); return; }
    const resolvedId = id || listSessions(getConfig().cwd)[0]?.id;
    if (!resolvedId) { print("No saved chats for this workspace.", "error"); return; }
    const session = loadSession(getConfig().cwd, resolvedId);
    if (!session) { print(`Session not found: ${resolvedId}`, "error"); return; }
    ws.data.stateVersion++;
    ws.data.history = session.history;
    ws.data.sessionId = session.id;
    ws.data.createdAt = session.createdAt;
    ws.data.sysFp = undefined;
    send(ws, { t: "load", messages: replayMessages(session.history) });
    pushContext(ws);
    send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
  };

  try {
    await runCommand(input, {
      history: ws.data.history,
      print,
      clearHistory: () => newChat(ws),
      exit: () => print("The web workbench stays open; close this browser tab to leave."),
      mode: ws.data.mode,
      setMode: (next) => { ws.data.mode = next; ws.data.stateVersion++; saveConfig({ mode: next }); send(ws, { t: "mode", mode: next }); },
      compact: async () => {
        const before = estimateTokens(ws.data.history);
        const summary = await summarizeConversation(ws.data.history);
        ws.data.history = compactHistory(ws.data.history, summary);
        const after = estimateTokens(ws.data.history);
        print(`Compacted — saved ~${Math.max(0, before - after).toLocaleString()} tokens (now ~${after.toLocaleString()}).`);
        pushContext(ws); autosave(ws);
      },
      saveSession: () => { autosave(ws); print("Session saved."); },
      resume: loadById,
      openModelPicker: () => send(ws, { t: "ui_action", action: "models" }),
      openSessionPicker: () => send(ws, { t: "ui_action", action: "sessions" }),
      openFiles: () => send(ws, { t: "ui_action", action: "files" }),
      addPaths: (paths) => print(addContextPaths(ws, paths), paths.length ? "info" : "error"),
      runInit: () => { void runChat(ws, "Explore this project, then create a concise LOCALCLI.md at the project root covering run/build/test commands, layout, key files, and conventions. Keep it under about 60 lines.", true); },
      learnProfile: (name) => {
        if (isIncognito()) { print("Profile learning is disabled in incognito.", "error"); return; }
        const selected = name || getActiveProfileName() || "default";
        setActiveProfile(selected); broadcastConfig();
        void runChat(ws, learnProfileInstruction(profileFilePath(selected), selected), true);
      },
      openProfilePicker: () => send(ws, { t: "ui_action", action: "profiles" }),
      runAgent: (_display, instruction) => { void runChat(ws, instruction, true); },
    });
  } catch (error: any) {
    print(`Command failed: ${String(error?.message ?? error)}`, "error");
  }
}

// ── incognito ──────────────────────────────────────────────────────────────
// The flag is process-wide on purpose: the persistence guards live inside the
// shared modules (config, session, memory, history…), so a per-tab flag would
// be a lie the moment a second tab was open. Toggling it therefore affects
// every connected client, and every client is told.
function toggleIncognito(on: boolean) {
  if (!setIncognito(on)) return; // already in that state

  if (!on) {
    // Discard every config change made during the session — saveConfig kept
    // them in memory only, so re-reading disk is what makes them disappear.
    resetConfigCache();
    // Tear down the throwaway search browser and delete its profile directory.
    void closePrivateChrome();
  }

  // Wipe the in-flight conversation on BOTH edges. Entering: so a chat that was
  // already autosaved doesn't continue into (and get mixed with) incognito
  // content. Leaving: so incognito content can't end up in the next autosave.
  for (const c of uiClients) {
    try {
      if (c.data.activeRunId) runEvent(c, c.data.activeRunId, "run_end", { outcome: "cancelled", durationMs: 0, toolCount: 0, usage: null, mode: c.data.mode });
      c.data.activeRunId = null;
      c.data.busy = false;
      c.data.stateVersion++;
      settlePending(c.data);
      c.data.abort?.abort();
      c.data.history = freshHistory(c.data.mode);
      c.data.sessionId = newSessionId();
      c.data.createdAt = Date.now();
      c.data.sysFp = undefined; // force a system-prompt rebuild with/without the incognito block
      send(c, { t: "cleared" });
      send(c, { t: "incognito", state: incognitoState(), backendWarning: remoteBackendWarning(getConfig().baseUrl) });
      send(c, { t: "config", config: configPayload() });
      send(c, { t: "sessions", list: on ? [] : listSessions(getConfig().cwd), active: c.data.sessionId });
      pushContext(c);
    } catch {}
  }
  console.log(on
    ? "  ◆ incognito ON — session persistence and outbound search are disabled"
    : "  ◆ incognito OFF — normal persistence resumed");
}

const handlers: any = {
  async fetch(req: Request, server: any) {
    const url = new URL(req.url);

    // This is a machine-local control surface, not a LAN service. Checking the
    // Host as well as binding to loopback blocks DNS-rebinding style access.
    if (!isLoopbackHost(url.hostname)) return new Response("Loopback access only", { status: 421, headers: securityHeaders("text/plain; charset=utf-8") });

    // Same-origin pages (and the explicitly installed extension) use this
    // process-random bearer to authenticate subsequent REST and socket calls.
    // Cross-origin browser JavaScript cannot read the response.
    if (url.pathname === "/api/bootstrap") {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: securityHeaders("text/plain; charset=utf-8") });
      if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403, headers: securityHeaders("text/plain; charset=utf-8") });
      return Response.json({ token: BOOT_TOKEN, protocol: 2 }, { headers: securityHeaders("application/json; charset=utf-8") });
    }

    if (url.pathname === "/ws" || url.pathname === "/ext") {
      const startMode = getConfig().mode ?? "normal";
      const kind = url.pathname === "/ext" ? "ext" : "ui";
      if (!tokenMatches(url.searchParams.get("token")) || !allowedSocketOrigin(req, url, kind)) {
        return new Response("Unauthorized", { status: 401, headers: securityHeaders("text/plain; charset=utf-8") });
      }
      const clientId = safeClientId(url.searchParams.get("clientId"));
      const data = kind === "ui"
        ? resumeOrCreateClient(clientId, startMode)
        : newWSData("ext", clientId, startMode);
      const ok = server.upgrade(req, {
        data,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname.startsWith("/api/") && !tokenMatches(req.headers.get("x-local-cli-token"))) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: securityHeaders("application/json; charset=utf-8") });
    }

    if (url.pathname === "/api/config") return Response.json(configPayload());
    if (url.pathname === "/api/commands") return Response.json(commandList());
    if (url.pathname === "/api/models") {
      try { return Response.json(await listOllamaModelsDetailed(getConfig().baseUrl)); } catch { return Response.json([]); }
    }
    if (url.pathname === "/api/modelinfo") {
      const name = url.searchParams.get("name") || getConfig().model;
      return Response.json((await modelInfo(getConfig().baseUrl, name).catch(() => null)) ?? {});
    }
    if (url.pathname === "/api/sessions") return Response.json(isIncognito() ? [] : listSessions(getConfig().cwd));
    if (url.pathname === "/api/profiles") return Response.json({ names: listProfileNames(), active: getActiveProfileName() });
    if (url.pathname === "/api/profile") {
      const name = url.searchParams.get("name") || getActiveProfileName() || "";
      return Response.json({ name, content: name ? readProfileByName(name) : null });
    }
    if (url.pathname === "/api/servers") {
      return Response.json(listServers().map(p => ({ id: p.id, status: p.status, url: p.url, command: p.command, exitCode: p.exitCode })));
    }
    if (url.pathname === "/api/serverlogs") {
      const id = url.searchParams.get("id") || "";
      return Response.json({ id, lines: serverLogs(id, 200) });
    }
    if (url.pathname === "/api/ports") return Response.json(listListeningPorts());
    if (url.pathname === "/api/system") { const info = systemInfo(); return Response.json({ info, recommendations: recommendModels(info) }); }
    if (url.pathname === "/api/loaded") {
      // Models currently resident in Ollama's memory, with the GPU/RAM split so
      // the UI can show when one spilled out of VRAM.
      try { return Response.json(await loadedModels(getConfig().baseUrl)); } catch { return Response.json([]); }
    }
    if (url.pathname === "/api/dir") {
      const p = url.searchParams.get("path") || getConfig().cwd;
      const dir = normalizeBrowsePath(p, getConfig().cwd);
      const isRoot = isRootDir(dir);
      const drives = listDrives();
      return Response.json({ dir, isRoot, drives, entries: listDirEntries(dir, isRoot) });
    }

    let requested: string;
    try { requested = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^[/\\]+/, "")); }
    catch { return new Response("Bad path", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") }); }
    if (requested.includes("\0")) return new Response("Bad path", { status: 400, headers: securityHeaders("text/plain; charset=utf-8") });
    const absolute = resolve(PUBLIC, requested);
    const rel = relative(PUBLIC, absolute);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[a-zA-Z]:/.test(rel)) {
      return new Response("Not found", { status: 404, headers: securityHeaders("text/plain; charset=utf-8") });
    }
    const file = Bun.file(absolute);
    if (await file.exists()) return new Response(file, { headers: securityHeaders(file.type || undefined) });
    return new Response("Not found", { status: 404, headers: securityHeaders("text/plain; charset=utf-8") });
  },

  websocket: {
    idleTimeout: 900, // 15 minutes (in seconds) to prevent disconnection during slow prefill/generations
    async open(ws: ServerWebSocket<WSData>) {
      ws.data.connected = true;
      if (ws.data.kind === "ext") {
        if (extensionClient && extensionClient !== ws) {
          try { ws.close(1008, "An extension session is already connected"); } catch {}
          return;
        }
        extensionClient = ws;
        setExtension((obj) => { try { ws.send(JSON.stringify(obj)); } catch {} });
        send(ws, { t: "ready", config: configPayload(), ext: true, protocol: 2, sessionId: ws.data.sessionId });
        send(ws, { t: "mode", mode: ws.data.mode });
        broadcastConfig(); // tell the web UI the extension is now live
        return;
      }
      uiClients.add(ws);
      send(ws, {
        t: "ready", config: configPayload(), protocol: 2,
        clientId: ws.data.clientId, sessionId: ws.data.sessionId, resumed: ws.data.resumed,
      });
      send(ws, { t: "mode", mode: ws.data.mode });
      if (ws.data.resumed && ws.data.history.length > 1) send(ws, { t: "load", messages: replayMessages(ws.data.history), resumed: true });
      ws.data.resumed = false;
      // A tab opened while incognito is already on joins it — the guards are
      // process-wide, so showing it anything else would be misleading.
      send(ws, { t: "incognito", state: incognitoState(), backendWarning: remoteBackendWarning(getConfig().baseUrl) });
      send(ws, { t: "sessions", list: isIncognito() ? [] : listSessions(getConfig().cwd), active: ws.data.sessionId });
      pushContext(ws);
      void warmUp();
    },
    async message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      // Keep the two socket capabilities separate: the extension may only
      // answer page commands, and a UI tab may never spoof those answers.
      if (ws.data.kind === "ext") {
        if (m.t === "cmdreply" && Number.isSafeInteger(m.id)) resolveCommand(m.id, m.result);
        return;
      }
      switch (m.t) {
        case "slash": {
          const input = typeof m.input === "string" ? m.input.trim().slice(0, 4_000) : "";
          if (input.startsWith("/")) void runSlashCommand(ws, input);
          break;
        }
        case "chat": {
          const imgs: string[] = Array.isArray(m.images)
            ? m.images.filter((x: any) => typeof x === "string" && x.length > 0 && x.length < 7_000_000 && /^[a-zA-Z0-9+/]+={0,2}$/.test(x)).slice(0, 4)
            : [];
          const text = typeof m.text === "string" ? m.text.trim() : "";
          if (text || imgs.length) void runChat(ws, text || "(attached image)", true, imgs);
          break;
        }
        case "permission": {
          if (!Number.isSafeInteger(m.id)) break;
          const pending = ws.data.pending.get(m.id);
          if (!pending || pending.kind !== "permission") break;
          if (pending.callId && m.callId !== pending.callId) break;
          ws.data.pending.delete(m.id);
          const approved = !!m.approved;
          if (approved && m.always) {
            const cur = getConfig().alwaysAllow ?? [];
            if (!cur.includes(pending.tool)) {
              saveConfig({ alwaysAllow: [...cur, pending.tool] });
              send(ws, { t: "notice", v: `${pending.tool} is now always allowed — I won't ask again. (Manage with /allow.)` });
            }
          }
          pending.resolve(approved);
          break;
        }
        case "choice": {
          if (!Number.isSafeInteger(m.id)) break;
          const pending = ws.data.pending.get(m.id);
          if (!pending || pending.kind !== "choice") break;
          const answer = String(m.answer ?? "");
          if (!pending.options.includes(answer)) break;
          ws.data.pending.delete(m.id); pending.resolve(answer); break;
        }
        case "plan_decision": {
          if (!Number.isSafeInteger(m.id) || !["approve", "keep", "reject"].includes(m.decision)) break;
          const pending = ws.data.pending.get(m.id);
          if (!pending || pending.kind !== "plan") break;
          ws.data.pending.delete(m.id);
          if (m.decision === "approve") {
            ws.data.mode = "normal";
            saveConfig({ mode: "normal" });
            send(ws, { t: "mode", mode: "normal" });
          }
          pending.resolve(m.decision); break;
        }
        case "interrupt": settlePending(ws.data); ws.data.abort?.abort(); break;
        case "new": if (!blockStateChange(ws, "starting a new chat")) newChat(ws); break;
        case "set_incognito": toggleIncognito(!!m.on); break;
        case "set_mode": if (["normal", "chat", "plan", "auto", "debug"].includes(m.mode) && !blockStateChange(ws, "changing mode", true)) { ws.data.mode = m.mode; ws.data.stateVersion++; saveConfig({ mode: m.mode }); send(ws, { t: "mode", mode: m.mode }); } break;
        case "set_thinking": if (!blockStateChange(ws, "changing reasoning generation", true)) { saveConfig({ thinking: !!m.on }); broadcastConfig(); } break;
        case "set_pm": if (["auto", "bun", "npm", "pnpm", "yarn"].includes(m.pm) && !blockStateChange(ws, "changing package manager", true)) { saveConfig({ packageManager: m.pm }); broadcastConfig(); } break;
        case "set_profile": if (typeof m.name === "string" && !blockStateChange(ws, "changing profile", true)) { setActiveProfile(m.name); broadcastConfig(); send(ws, { t: "notice", v: `Active coding profile: ${m.name}` }); } break;
        case "del_profile": if (typeof m.name === "string" && !blockStateChange(ws, "deleting a profile", true)) { deleteProfileByName(m.name); broadcastConfig(); } break;
        case "learn": {
          if (blockStateChange(ws, "learning a profile", true)) break;
          // Profile writes are blocked at the writer — stop here rather than
          // burning a full agent turn producing something we'd then discard.
          if (isIncognito()) { send(ws, { t: "error", v: "Learning a coding profile writes to ~/.local-cli/profiles/ — disabled while incognito is on." }); break; }
          const name = (typeof m.name === "string" && m.name.trim()) || getActiveProfileName() || "default";
          setActiveProfile(name); pushConfig(ws);
          void runChat(ws, learnProfileInstruction(profileFilePath(name), name), true);
          break;
        }
        case "init": if (!blockStateChange(ws, "initializing project context")) void runChat(ws, "Explore this project — read package.json / manifests, scan the directory structure, and read the key entry files. Then create a concise LOCALCLI.md at the project root with write_file summarizing what it is, how to run/build/test it, the layout, the key files, and conventions. Keep it under ~60 lines.", true); break;
        case "compact": {
          if (blockStateChange(ws, "compacting the conversation", true)) break;
          send(ws, { t: "notice", v: "Compacting conversation…" });
          try {
            const before = estimateTokens(ws.data.history);
            const summary = await summarizeConversation(ws.data.history);
            ws.data.history = compactHistory(ws.data.history, summary);
            const after = estimateTokens(ws.data.history);
            send(ws, { t: "notice", v: `Compacted — saved ~${(before - after).toLocaleString()} tokens (now ~${after.toLocaleString()}).` });
          } catch (e: any) { send(ws, { t: "error", v: "Compact failed: " + e.message }); }
          pushContext(ws); autosave(ws);
          break;
        }
        case "set_model": {
          if (typeof m.model === "string" && !blockStateChange(ws, "changing model", true)) {
            saveConfig({ model: m.model }); resetClient();
            const info = await modelInfo(getConfig().baseUrl, m.model).catch(() => null);
            if (info?.contextLength) {
              // Always adopt the model's full native context — never cap it, so a
              // large-context model gets the window it supports (a too-small
              // num_ctx silently truncates the prompt → empty responses).
              saveConfig({ contextWindow: info.contextLength });
              send(ws, { t: "notice", v: `Context window set to ${info.contextLength.toLocaleString()} tokens for ${m.model} (its native limit).` });
            }
            // Proactive heads-up if the model won't fit the GPU/RAM budget.
            const size = await modelDiskSize(getConfig().baseUrl, m.model).catch(() => undefined);
            const fitWarn = modelFitWarning(size, info?.contextLength);
            if (fitWarn) send(ws, { t: "error", v: fitWarn });
            void warmUp(); // pre-load the new model with the real options
            broadcastConfig(); pushContext(ws);
          }
          break;
        }
        case "set_cwd": {
          if (blockStateChange(ws, "changing working folder", true)) break;
          const p = String(m.path ?? "");
          const dir = normalizeBrowsePath(p, "");
          if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
            saveConfig({ cwd: dir }); broadcastConfig();
            newChat(ws);
            send(ws, { t: "sessions", list: isIncognito() ? [] : listSessions(dir), active: ws.data.sessionId });
            send(ws, { t: "notice", v: `Working directory set to ${dir}` });
          } else { send(ws, { t: "error", v: `Not a directory: ${p}` }); }
          break;
        }
        case "add_files": {
          if (blockStateChange(ws, "adding files to context")) break;
          const paths: string[] = Array.isArray(m.paths) ? m.paths : [];
          const result = addContextPaths(ws, paths);
          send(ws, { t: result.startsWith("Added ") ? "notice" : "error", v: result });
          break;
        }
        case "load_session": {
          if (blockStateChange(ws, "loading another session")) break;
          // Keep incognito hermetic in both directions: a saved chat doesn't get
          // pulled in, and nothing here can be confused for a resumable one.
          if (isIncognito()) { send(ws, { t: "error", v: "Saved chats can't be opened while incognito is on — turn it off first." }); break; }
          const s = loadSession(getConfig().cwd, String(m.id));
          if (s) {
            ws.data.stateVersion++;
            ws.data.history = s.history; ws.data.sessionId = s.id; ws.data.createdAt = s.createdAt;
            ws.data.sysFp = undefined;
            send(ws, { t: "load", messages: replayMessages(s.history) });
            pushContext(ws);
            send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
          }
          break;
        }
        case "delete_session": {
          if (blockStateChange(ws, "deleting a session")) break;
          deleteSession(getConfig().cwd, String(m.id));
          if (m.id === ws.data.sessionId) newChat(ws);
          send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
          break;
        }
        case "stop_server": { stopServer(String(m.id)); send(ws, { t: "servers", list: serverList() }); break; }
        case "servers": send(ws, { t: "servers", list: serverList() }); break;
        case "browser_open": {
          try {
            const r = await browserOpen(String(m.url));
            const text = await browserReadText().catch(() => "");
            const screenshot = await browserScreenshot().catch(() => "");
            send(ws, { t: "browser_state", url: r.url, title: r.title, text, screenshot });
          } catch (e: any) {
            send(ws, { t: "browser_state", error: e.message });
          }
          break;
        }
        case "browser_shot": {
          try {
            const text = await browserReadText().catch(() => "");
            const screenshot = await browserScreenshot().catch(() => "");
            const url = await evalJs("document.location.href").catch(() => "");
            const title = await evalJs("document.title").catch(() => "");
            send(ws, { t: "browser_state", url, title, text, screenshot, refreshed: true });
          } catch (e: any) {
            send(ws, { t: "browser_state", error: e.message });
          }
          break;
        }
        case "browser_close": {
          manualLive = false;
          await browserStopScreencast().catch(() => {});
          await browserClose().catch(() => {});
          send(ws, { t: "browser_state", closed: true });
          break;
        }
        case "browser_live": {
          // User-driven live view toggle from the Browser tab.
          if (m.on) {
            if (await startLiveView()) { manualLive = true; send(ws, { t: "browser_live", on: true }); }
            else send(ws, { t: "browser_state", error: "No controlled browser is open yet — open a URL first." });
          } else {
            manualLive = false;
            await browserStopScreencast().catch(() => {});
            send(ws, { t: "browser_live", on: false });
          }
          break;
        }
        case "kill_port": {
          const port = Number(m.port);
          if (!Number.isInteger(port) || port < 1 || port > 65_535) { send(ws, { t: "error", v: "Invalid TCP port." }); break; }
          const r = killPort(port);
          send(ws, { t: "notice", v: r.ok ? `Freed port ${r.port} (killed ${r.killed.map(k => "PID " + k.pid).join(", ")}).` : `Nothing was listening on port ${port}.` });
          send(ws, { t: "ports", list: listListeningPorts() }); break;
        }
        case "ports": send(ws, { t: "ports", list: listListeningPorts() }); break;
      }
    },
    close(ws: ServerWebSocket<WSData>) {
      ws.data.connected = false;
      settlePending(ws.data);
      ws.data.abort?.abort();
      ws.data.stateVersion++;
      ws.data.busy = false;
      ws.data.activeRunId = null;
      if (ws.data.kind === "ext") {
        if (extensionClient === ws) {
          extensionClient = null;
          setExtension(null);
          broadcastConfig();
        }
      } else {
        uiClients.delete(ws);
        retainedClients.set(ws.data.clientId, { data: ws.data, expiresAt: Date.now() + CLIENT_STATE_TTL_MS });
      }
    },
  },
};

function boot(port: number): import("bun").Server<WSData> | null {
  try { return Bun.serve<WSData>({ hostname: "127.0.0.1", port, ...handlers }); }
  catch (e: any) {
    if (String(e?.message ?? e).match(/EADDRINUSE|in use|already|address/i)) return null;
    throw e;
  }
}

let server = boot(PORT);
if (!server) {
  // Never kill a process merely because it happens to be Bun/Node/Deno. It may
  // be unrelated user work; choose the next local port instead.
  for (let p = PORT + 1; !server && p <= PORT + 25; p++) server = boot(p);
}
if (!server) { console.error(`\n  ✗ Couldn't find a free port near ${PORT}. Free one with the Ports panel or set PORT=...\n`); process.exit(1); }
if (server.port !== PORT) console.error(`  (port ${PORT} was busy — using ${server.port} instead)`);

function serverList() {
  return listServers().map(p => ({ id: p.id, status: p.status, url: p.url, command: p.command, exitCode: p.exitCode }));
}

// Turn a stored history into renderable chat messages (user + assistant text,
// plus a compact note for tool steps so a resumed chat reads sensibly).
function replayMessages(history: ChatCompletionMessageParam[]) {
  const out: { role: string; content: string; tool?: boolean }[] = [];
  for (const m of history) {
    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.startsWith("<tool_response") || m.content.startsWith("I'm attaching")) continue;
      const imgNote = (m as any).images?.length ? `  [${(m as any).images.length} image(s) attached]` : "";
      out.push({ role: "user", content: m.content + imgNote });
    } else if (m.role === "assistant") {
      const tc = (m as any).tool_calls;
      if (typeof m.content === "string" && m.content.trim()) out.push({ role: "assistant", content: m.content });
      if (tc?.length) out.push({ role: "assistant", content: `↳ ran ${tc.length} tool call(s): ${tc.map((c: any) => c.function?.name).join(", ")}`, tool: true });
    }
  }
  return out;
}

console.log(`\n  ◆ local-cli web UI  →  http://localhost:${server.port}\n  working dir: ${getConfig().cwd}\n`);
