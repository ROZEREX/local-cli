// Web UI server — a full browser front end for local-cli, powered by the SAME
// agent core as the terminal (src/llm.ts, tools, config, sessions, profiles,
// servers…). It serves a Tailwind single-page app and bridges it to chat() over a
// WebSocket, plus REST endpoints for models / sessions / folders / profiles.
// The terminal CLI is untouched. Run with:  bun run web
import { join, resolve } from "path";
import { existsSync, statSync } from "fs";
import type { ServerWebSocket } from "bun";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  chat, estimateTokens, resetClient, warmUp, summarizeConversation, compactHistory,
} from "../src/llm";
import { getConfig, saveConfig } from "../src/config";
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
import { listDirEntries, expandSelection, readFilesAsContext } from "../src/files";
import {
  browserOpen, browserReadText, browserClose, browserScreenshot, evalJs,
  browserStartScreencast, browserStopScreencast, browserIsOpen,
} from "../src/browser";
import { setExtension, resolveCommand, extensionConnected } from "../src/extbridge";

const PUBLIC = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 4317);

interface WSData {
  kind: "ui" | "ext";
  history: ChatCompletionMessageParam[];
  mode: Mode;
  busy: boolean;
  abort: AbortController | null;
  pending: Map<number, (v: any) => void>;
  seq: number;
  sessionId: string;
  createdAt: number;
  // Fingerprint of the inputs that shape the system prompt (see runChat).
  sysFp?: string;
}

const send = (ws: ServerWebSocket<WSData>, obj: any) => ws.send(JSON.stringify(obj));

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
  ].join("|");
}

function configPayload() {
  const cfg = getConfig();
  return {
    model: cfg.model, cwd: cfg.cwd, contextWindow: cfg.contextWindow, baseUrl: cfg.baseUrl,
    thinking: cfg.thinking !== false, packageManager: cfg.packageManager,
    activeProfile: getActiveProfileName(), profiles: listProfileNames(),
    availablePM: availablePackageManagers(), mode: cfg.mode ?? "normal",
    extConnected: extensionConnected(),
    keepAlive: cfg.keepAlive ?? "(ollama default, 5m)", numGpu: cfg.numGpu ?? null, numThread: cfg.numThread ?? null,
    maxTokens: cfg.maxTokens, temperature: cfg.temperature,
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
  if (name === "browser_type" || name === "page_type") return `type "${a.text}" into ${a.target}`;
  return JSON.stringify(a);
}

function pushContext(ws: ServerWebSocket<WSData>) {
  send(ws, { t: "context", used: estimateTokens(ws.data.history), limit: getConfig().contextWindow });
}
function pushConfig(ws: ServerWebSocket<WSData>) { send(ws, { t: "config", config: configPayload() }); }

function autosave(ws: ServerWebSocket<WSData>) {
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
  ws.data.busy = true;
  ws.data.abort = new AbortController();
  if (echo) send(ws, { t: "user", text: userText, images });
  // Refresh the system prompt ONLY when its inputs changed (mode/profile/…) —
  // a stable prompt keeps Ollama's prompt cache valid between turns.
  const fp = systemFingerprint(ws.data.mode);
  if (ws.data.sysFp !== fp) { ws.data.history[0] = freshSystem(ws.data.mode); ws.data.sysFp = fp; }

  // Pasted images: hand them to the model directly if it has vision; otherwise
  // describe them with the fallback vision model and attach the description.
  if (images.length) {
    const cfg = getConfig();
    const caps = await modelCapabilities(cfg.baseUrl, cfg.model).catch(() => [] as string[]);
    if (caps.includes("vision")) {
      ws.data.history.push({ role: "user", content: userText, images } as any);
    } else {
      send(ws, { t: "notice", v: `"${cfg.model}" can't see images — describing them with a vision model instead.` });
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
      if (s.text) send(ws, { t: "text", v: s.text, think: s.think });
    }
  };

  try {
    ws.data.history = await chat(
      ws.data.history,
      {
        onText: (c) => emitText(c),
        onToolCall: (name, args) => send(ws, { t: "tool_call", name, summary: summarize(name, args) }),
        onToolResult: async (name, result) => {
          send(ws, { t: "tool_result", name, result });
          if (name.startsWith("browser_") && name !== "browser_close") {
            // The browser is open now — start the live screencast so the user
            // watches the rest of the agent's browsing in real time.
            void startLiveView();
            try {
              const text = await browserReadText().catch(() => "");
              const screenshot = await browserScreenshot().catch(() => "");
              const url = await evalJs("document.location.href").catch(() => "");
              const title = await evalJs("document.title").catch(() => "");
              send(ws, { t: "browser_state", url, title, text, screenshot });
            } catch {}
          }
        },
        onError: (e) => send(ws, { t: "error", v: e.message }),
        onNotice: (v) => send(ws, { t: "notice", v }),
        onStatus: (phase) => send(ws, { t: "status", phase }),
        onUsage: (u) => send(ws, { t: "usage", inTok: u.inputTokens, outTok: u.outputTokens, tps: u.tokPerSec }),
        onProgress: (tok) => send(ws, { t: "progress", tok }),
        requestPermission: (name, args) => new Promise<boolean>((res) => {
          const id = ++ws.data.seq; ws.data.pending.set(id, res);
          send(ws, { t: "permission", id, tool: name, detail: permDetail(name, args) });
        }),
        requestChoice: (question, options) => new Promise<string>((res) => {
          const id = ++ws.data.seq; ws.data.pending.set(id, res);
          send(ws, { t: "choice", id, question, options });
        }),
      },
      { signal: ws.data.abort.signal, planMode: ws.data.mode === "plan", autoAccept: ws.data.mode === "auto" }
    );
    emitText(null);
  } catch (e: any) {
    send(ws, { t: "error", v: String(e?.message ?? e) });
  } finally {
    ws.data.busy = false;
    ws.data.abort = null;
    // Stop the live screencast unless the user explicitly keeps it on — the
    // last browser_state screenshot stays as the final frame.
    if (!manualLive) void browserStopScreencast();
    send(ws, { t: "turn_end", mode: ws.data.mode });
    pushContext(ws);
    autosave(ws);
  }
}

function newChat(ws: ServerWebSocket<WSData>) {
  ws.data.history = freshHistory(ws.data.mode);
  ws.data.sessionId = newSessionId();
  ws.data.createdAt = Date.now();
  send(ws, { t: "cleared" });
  pushContext(ws);
}

const handlers: any = {
  async fetch(req: Request, server: any) {
    const url = new URL(req.url);

    if (url.pathname === "/ws" || url.pathname === "/ext") {
      const startMode = getConfig().mode ?? "normal";
      const kind = url.pathname === "/ext" ? "ext" : "ui";
      const ok = server.upgrade(req, {
        data: { kind, history: freshHistory(startMode), mode: startMode, busy: false, abort: null, pending: new Map(), seq: 0, sessionId: newSessionId(), createdAt: Date.now() },
      });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/api/config") return Response.json(configPayload());
    if (url.pathname === "/api/models") {
      try { return Response.json(await listOllamaModelsDetailed(getConfig().baseUrl)); } catch { return Response.json([]); }
    }
    if (url.pathname === "/api/modelinfo") {
      const name = url.searchParams.get("name") || getConfig().model;
      return Response.json((await modelInfo(getConfig().baseUrl, name).catch(() => null)) ?? {});
    }
    if (url.pathname === "/api/sessions") return Response.json(listSessions(getConfig().cwd));
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
      let dir = p;
      try { dir = resolve(p); if (!statSync(dir).isDirectory()) dir = getConfig().cwd; } catch { dir = getConfig().cwd; }
      return Response.json({ dir, entries: listDirEntries(dir, false) });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(PUBLIC, path));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    idleTimeout: 900, // 15 minutes (in seconds) to prevent disconnection during slow prefill/generations
    async open(ws: ServerWebSocket<WSData>) {
      if (ws.data.kind === "ext") {
        setExtension((obj) => { try { ws.send(JSON.stringify(obj)); } catch {} });
        send(ws, { t: "ready", config: configPayload(), ext: true });
        send(ws, { t: "mode", mode: ws.data.mode });
        broadcastConfig(); // tell the web UI the extension is now live
        return;
      }
      uiClients.add(ws);
      send(ws, { t: "ready", config: configPayload() });
      send(ws, { t: "mode", mode: ws.data.mode });
      send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
      pushContext(ws);
      void warmUp();
    },
    async message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      // The extension reports the result of a page command (page_read/click/…).
      if (m.t === "cmdreply") { resolveCommand(m.id, m.result); return; }
      const cfg = getConfig();
      switch (m.t) {
        case "chat": {
          const imgs: string[] = Array.isArray(m.images)
            ? m.images.filter((x: any) => typeof x === "string" && x.length > 0 && x.length < 15_000_000).slice(0, 4)
            : [];
          const text = typeof m.text === "string" ? m.text.trim() : "";
          if (text || imgs.length) void runChat(ws, text || "(attached image)", true, imgs);
          break;
        }
        case "permission": {
          if (m.approved && m.always && m.tool) {
            const cur = getConfig().alwaysAllow ?? [];
            if (!cur.includes(m.tool)) { saveConfig({ alwaysAllow: [...cur, m.tool] }); send(ws, { t: "notice", v: `${m.tool} is now always allowed — I won't ask again. (Manage with /config or reset in settings.)` }); }
          }
          const r = ws.data.pending.get(m.id); if (r) { ws.data.pending.delete(m.id); r(!!m.approved); }
          break;
        }
        case "choice": { const r = ws.data.pending.get(m.id); if (r) { ws.data.pending.delete(m.id); r(String(m.answer ?? "")); } break; }
        case "interrupt": ws.data.abort?.abort(); break;
        case "new": newChat(ws); break;
        case "set_mode": if (["normal", "plan", "auto", "debug"].includes(m.mode)) { ws.data.mode = m.mode; saveConfig({ mode: m.mode }); send(ws, { t: "mode", mode: m.mode }); } break;
        case "set_thinking": saveConfig({ thinking: !!m.on }); pushConfig(ws); break;
        case "set_pm": if (["auto", "bun", "npm", "pnpm", "yarn"].includes(m.pm)) { saveConfig({ packageManager: m.pm }); pushConfig(ws); } break;
        case "set_profile": if (typeof m.name === "string") { setActiveProfile(m.name); pushConfig(ws); send(ws, { t: "notice", v: `Active coding profile: ${m.name}` }); } break;
        case "del_profile": if (typeof m.name === "string") { deleteProfileByName(m.name); pushConfig(ws); } break;
        case "learn": {
          const name = (typeof m.name === "string" && m.name.trim()) || getActiveProfileName() || "default";
          setActiveProfile(name); pushConfig(ws);
          void runChat(ws, learnProfileInstruction(profileFilePath(name), name), true);
          break;
        }
        case "init": void runChat(ws, "Explore this project — read package.json / manifests, scan the directory structure, and read the key entry files. Then create a concise LOCALCLI.md at the project root with write_file summarizing what it is, how to run/build/test it, the layout, the key files, and conventions. Keep it under ~60 lines.", true); break;
        case "compact": {
          if (ws.data.busy) break;
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
          if (typeof m.model === "string") {
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
            pushConfig(ws); pushContext(ws);
          }
          break;
        }
        case "set_cwd": {
          const p = String(m.path ?? "");
          let dir = p;
          try { dir = resolve(p); } catch {}
          if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
            saveConfig({ cwd: dir }); pushConfig(ws);
            newChat(ws);
            send(ws, { t: "sessions", list: listSessions(dir), active: ws.data.sessionId });
            send(ws, { t: "notice", v: `Working directory set to ${dir}` });
          } else { send(ws, { t: "error", v: `Not a directory: ${p}` }); }
          break;
        }
        case "add_files": {
          const paths: string[] = Array.isArray(m.paths) ? m.paths : [];
          const files = expandSelection(paths.map(p => resolve(getConfig().cwd, p)));
          const res = readFilesAsContext(files, getConfig().cwd);
          if (res.included.length) {
            ws.data.history.push({ role: "user", content: `I'm attaching these files for context:\n\n${res.block}` });
            send(ws, { t: "notice", v: `Added ${res.included.length} file(s) to context: ${res.included.join(", ")}${res.skipped ? ` (${res.skipped} skipped)` : ""}` });
            pushContext(ws); autosave(ws);
          } else { send(ws, { t: "error", v: "No readable files in that selection." }); }
          break;
        }
        case "load_session": {
          const s = loadSession(getConfig().cwd, String(m.id));
          if (s) {
            ws.data.history = s.history; ws.data.sessionId = s.id; ws.data.createdAt = s.createdAt;
            send(ws, { t: "load", messages: replayMessages(s.history) });
            pushContext(ws);
            send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
          }
          break;
        }
        case "delete_session": {
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
        case "kill_port": { const r = killPort(Number(m.port)); send(ws, { t: "notice", v: r.ok ? `Freed port ${r.port} (killed ${r.killed.map(k => "PID " + k.pid).join(", ")}).` : `Nothing was listening on port ${m.port}.` }); send(ws, { t: "ports", list: listListeningPorts() }); break; }
        case "ports": send(ws, { t: "ports", list: listListeningPorts() }); break;
      }
    },
    close(ws: ServerWebSocket<WSData>) { if (ws.data.kind === "ext") { setExtension(null); broadcastConfig(); } else { uiClients.delete(ws); } ws.data.abort?.abort(); ws.data.pending.clear(); },
  },
};

function boot(port: number): import("bun").Server<WSData> | null {
  try { return Bun.serve<WSData>({ port, ...handlers }); }
  catch (e: any) {
    if (String(e?.message ?? e).match(/EADDRINUSE|in use|already|address/i)) return null;
    throw e;
  }
}

let server = boot(PORT);
if (!server) {
  // The port is taken. If it's our OWN stale server (a bun/node process left
  // behind by a previous run), free it and reuse the same port.
  const holder = listListeningPorts().find(p => p.port === PORT);
  if (holder && /bun|node|deno/i.test(holder.process)) {
    console.error(`  Port ${PORT} was held by a stale ${holder.process} (pid ${holder.pid}) — freeing it…`);
    killPort(PORT);
    await new Promise(r => setTimeout(r, 900));
    server = boot(PORT);
  }
}
if (!server) {
  // Still busy (or held by something unrelated) — use the next open port instead.
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
