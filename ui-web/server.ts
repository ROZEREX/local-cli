// Web UI server — a browser front end for local-cli, powered by the SAME agent
// core as the terminal (src/llm.ts, tools, config, profiles…). It serves a small
// single-page app and bridges it to chat() over a WebSocket: user messages go in,
// streamed text / tool calls / permission prompts come out. The CLI is untouched;
// this is an additional, optional interface. Run with:  bun run ui-web/server.ts
import { join } from "path";
import type { ServerWebSocket } from "bun";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { chat, estimateTokens, resetClient, warmUp } from "../src/llm";
import { getConfig, saveConfig } from "../src/config";
import { systemPrompt } from "../src/prompt";
import { ThinkSplitter } from "../src/think";
import { listOllamaModelsDetailed, modelInfo } from "../src/ollama";

const PUBLIC = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 4317);

// Per-connection state.
interface WSData {
  history: ChatCompletionMessageParam[];
  busy: boolean;
  abort: AbortController | null;
  pending: Map<number, (v: any) => void>; // permission/choice resolvers
  seq: number;
}

function freshHistory(): ChatCompletionMessageParam[] {
  return [{ role: "system", content: systemPrompt({ mode: "normal" }) }];
}

const send = (ws: ServerWebSocket<WSData>, obj: any) => ws.send(JSON.stringify(obj));

// Short human summary of a tool call's args (mirrors the TUI's tool cards).
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

async function contextSnapshot(ws: ServerWebSocket<WSData>) {
  const cfg = getConfig();
  send(ws, { t: "context", used: estimateTokens(ws.data.history), limit: cfg.contextWindow });
}

async function runChat(ws: ServerWebSocket<WSData>, text: string) {
  if (ws.data.busy) return;
  ws.data.busy = true;
  ws.data.abort = new AbortController();
  ws.data.history.push({ role: "user", content: text });
  const splitter = new ThinkSplitter();
  const emitText = (chunk: string | null) => {
    const segs = chunk === null ? splitter.flush() : splitter.push(chunk);
    for (const s of segs) if (s.text) send(ws, { t: "text", v: s.text, think: s.think });
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
          const id = ++ws.data.seq;
          ws.data.pending.set(id, res);
          send(ws, { t: "permission", id, tool: name, detail: permDetail(name, args) });
        }),
        requestChoice: (question, options) => new Promise<string>((res) => {
          const id = ++ws.data.seq;
          ws.data.pending.set(id, res);
          send(ws, { t: "choice", id, question, options });
        }),
      },
      { signal: ws.data.abort.signal }
    );
    emitText(null);
  } catch (e: any) {
    send(ws, { t: "error", v: String(e?.message ?? e) });
  } finally {
    ws.data.busy = false;
    ws.data.abort = null;
    send(ws, { t: "turn_end" });
    await contextSnapshot(ws);
  }
}

const server = Bun.serve<WSData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: { history: freshHistory(), busy: false, abort: null, pending: new Map(), seq: 0 },
      });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/api/config") {
      const cfg = getConfig();
      return Response.json({ model: cfg.model, cwd: cfg.cwd, contextWindow: cfg.contextWindow, baseUrl: cfg.baseUrl });
    }
    if (url.pathname === "/api/models") {
      try { return Response.json(await listOllamaModelsDetailed(getConfig().baseUrl)); }
      catch { return Response.json([]); }
    }

    // Static files from ./public
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(PUBLIC, path));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    async open(ws) {
      const cfg = getConfig();
      send(ws, { t: "ready", model: cfg.model, cwd: cfg.cwd, contextWindow: cfg.contextWindow });
      await contextSnapshot(ws);
      void warmUp();
    },
    async message(ws, raw) {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      switch (m.t) {
        case "chat":
          if (typeof m.text === "string" && m.text.trim()) void runChat(ws, m.text.trim());
          break;
        case "permission": {
          const res = ws.data.pending.get(m.id);
          if (res) { ws.data.pending.delete(m.id); res(!!m.approved); }
          break;
        }
        case "choice": {
          const res = ws.data.pending.get(m.id);
          if (res) { ws.data.pending.delete(m.id); res(String(m.answer ?? "")); }
          break;
        }
        case "interrupt":
          ws.data.abort?.abort();
          break;
        case "new":
          ws.data.history = freshHistory();
          await contextSnapshot(ws);
          send(ws, { t: "cleared" });
          break;
        case "set_model": {
          if (typeof m.model === "string") {
            saveConfig({ model: m.model });
            resetClient();
            const info = await modelInfo(getConfig().baseUrl, m.model).catch(() => null);
            if (info?.contextLength) saveConfig({ contextWindow: info.contextLength });
            const cfg = getConfig();
            send(ws, { t: "model", model: cfg.model, contextWindow: cfg.contextWindow });
            await contextSnapshot(ws);
          }
          break;
        }
      }
    },
    close(ws) {
      ws.data.abort?.abort();
      ws.data.pending.clear();
    },
  },
});

console.log(`\n  local-cli web UI  →  http://localhost:${server.port}\n  (same agent core as the terminal; working dir: ${getConfig().cwd})\n`);
