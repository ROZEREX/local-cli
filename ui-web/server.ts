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
import { listOllamaModelsDetailed, modelInfo } from "../src/ollama";
import {
  saveSession, listSessions, deleteSession, loadSession, newSessionId, deriveTitle, type Session,
} from "../src/session";
import {
  listProfileNames, getActiveProfileName, readProfileByName, setActiveProfile,
  deleteProfileByName, learnProfileInstruction, profileFilePath, availablePackageManagers,
} from "../src/profile";
import { listServers, serverLogs, stopServer } from "../src/proc";
import { listListeningPorts, killPort } from "../src/ports";
import { listDirEntries, expandSelection, readFilesAsContext } from "../src/files";

const PUBLIC = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 4317);

interface WSData {
  history: ChatCompletionMessageParam[];
  mode: Mode;
  busy: boolean;
  abort: AbortController | null;
  pending: Map<number, (v: any) => void>;
  seq: number;
  sessionId: string;
  createdAt: number;
}

const send = (ws: ServerWebSocket<WSData>, obj: any) => ws.send(JSON.stringify(obj));

function freshSystem(mode: Mode): ChatCompletionMessageParam { return { role: "system", content: systemPrompt({ mode }) }; }
function freshHistory(mode: Mode): ChatCompletionMessageParam[] { return [freshSystem(mode)]; }

function configPayload() {
  const cfg = getConfig();
  return {
    model: cfg.model, cwd: cfg.cwd, contextWindow: cfg.contextWindow, baseUrl: cfg.baseUrl,
    thinking: cfg.thinking !== false, packageManager: cfg.packageManager,
    activeProfile: getActiveProfileName(), profiles: listProfileNames(),
    availablePM: availablePackageManagers(),
  };
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
    case "browser_screenshot": case "screenshot": return a.question ?? "";
    default: return "";
  }
}
function permDetail(name: string, a: any): string {
  if (name === "bash" || name === "run_server") return `$ ${a.command}`;
  if (name === "write_file") return `write ${a.path} (${a.content?.length ?? 0} chars)`;
  if (name === "edit_file") return `edit ${a.path}`;
  if (name === "delete_file") return `delete ${a.path}`;
  if (name === "update_profile") return `save to coding profile`;
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
async function runChat(ws: ServerWebSocket<WSData>, userText: string, echo = true) {
  if (ws.data.busy) return;
  ws.data.busy = true;
  ws.data.abort = new AbortController();
  if (echo) send(ws, { t: "user", text: userText });
  // Rebuild the system prompt each turn so mode / profile / pm / thinking changes apply.
  ws.data.history[0] = freshSystem(ws.data.mode);
  ws.data.history.push({ role: "user", content: userText });

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
        onToolResult: (name, result) => send(ws, { t: "tool_result", name, result }),
        onError: (e) => send(ws, { t: "error", v: e.message }),
        onNotice: (v) => send(ws, { t: "notice", v }),
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

let server: import("bun").Server<WSData>;
try {
server = Bun.serve<WSData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: { history: freshHistory("normal"), mode: "normal", busy: false, abort: null, pending: new Map(), seq: 0, sessionId: newSessionId(), createdAt: Date.now() },
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
    async open(ws) {
      send(ws, { t: "ready", config: configPayload() });
      send(ws, { t: "sessions", list: listSessions(getConfig().cwd), active: ws.data.sessionId });
      pushContext(ws);
      void warmUp();
    },
    async message(ws, raw) {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      const cfg = getConfig();
      switch (m.t) {
        case "chat": if (typeof m.text === "string" && m.text.trim()) void runChat(ws, m.text.trim()); break;
        case "permission": { const r = ws.data.pending.get(m.id); if (r) { ws.data.pending.delete(m.id); r(!!m.approved); } break; }
        case "choice": { const r = ws.data.pending.get(m.id); if (r) { ws.data.pending.delete(m.id); r(String(m.answer ?? "")); } break; }
        case "interrupt": ws.data.abort?.abort(); break;
        case "new": newChat(ws); break;
        case "set_mode": if (["normal", "plan", "auto"].includes(m.mode)) { ws.data.mode = m.mode; send(ws, { t: "mode", mode: m.mode }); } break;
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
            if (info?.contextLength) saveConfig({ contextWindow: info.contextLength });
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
        case "kill_port": { const r = killPort(Number(m.port)); send(ws, { t: "notice", v: r.ok ? `Freed port ${r.port} (killed ${r.killed.map(k => "PID " + k.pid).join(", ")}).` : `Nothing was listening on port ${m.port}.` }); send(ws, { t: "ports", list: listListeningPorts() }); break; }
        case "ports": send(ws, { t: "ports", list: listListeningPorts() }); break;
      }
    },
    close(ws) { ws.data.abort?.abort(); ws.data.pending.clear(); },
  },
});
} catch (e: any) {
  if (String(e?.message ?? e).match(/EADDRINUSE|in use|already/i)) {
    console.error(`\n  ✗ Port ${PORT} is already in use — another local-cli web server is probably still running.\n` +
      `    Stop the old one first (close its terminal / kill the process), then run \`bun run web\` again,\n` +
      `    or start this one on another port:  PORT=4318 bun run web\n`);
  } else {
    console.error("\n  ✗ Failed to start web UI:", e?.message ?? e, "\n");
  }
  process.exit(1);
}

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
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const tc = (m as any).tool_calls;
      if (typeof m.content === "string" && m.content.trim()) out.push({ role: "assistant", content: m.content });
      if (tc?.length) out.push({ role: "assistant", content: `↳ ran ${tc.length} tool call(s): ${tc.map((c: any) => c.function?.name).join(", ")}`, tool: true });
    }
  }
  return out;
}

console.log(`\n  ◆ local-cli web UI  →  http://localhost:${server.port}\n  working dir: ${getConfig().cwd}\n`);
