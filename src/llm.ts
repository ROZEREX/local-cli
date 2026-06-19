import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionChunk } from "openai/resources/chat/completions";
import { getConfig } from "./config";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { executeTool, canonicalToolName } from "./tools/executor";
import { detectToolSupport, isOllama, modelCapabilities, loadedModels } from "./ollama";
import { parseToolCalls, ProseFilter, NarrationFilter } from "./toolparse";
import { RepetitionGuard, HarmonyFilter, ToolLoopGuard } from "./think";
import { promptedToolInstructions } from "./prompt";
import { drainServerErrors } from "./proc";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  const cfg = getConfig();
  if (!_client || (_client as any)._baseURL !== cfg.baseUrl) {
    _client = new OpenAI({ 
      baseURL: cfg.baseUrl, 
      apiKey: cfg.apiKey,
      timeout: 900000 // 15 minutes (in ms) to allow for slow local prefill/generation
    });
  }
  return _client;
}

export function resetClient() {
  _client = null;
  _isOllamaCache = null;
}

// Connection errors worth one retry (cold model load can drop the socket).
function isTransient(err: any): boolean {
  if (err?.name === "AbortError") return false;
  const m = String(err?.message ?? err).toLowerCase();
  return ["socket", "econnreset", "connection", "terminated", "fetch failed", "network", "timeout", "timed out", "etimedout"].some(s => m.includes(s));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A child AbortController that also aborts when `external` does — lets the
// stream watchdog abort a stalled turn without losing the user's esc-to-stop.
function linkAbort(external?: AbortSignal): AbortController {
  const ac = new AbortController();
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}

// Watches a turn while we wait for the model's FIRST token. On a VRAM-constrained
// box a cold load can take many seconds (and a wedged server can hang forever),
// so this: (1) emits periodic "still loading" heartbeats so the UI never looks
// frozen, and (2) aborts the request if nothing arrives within a hard cap, so
// chat() can warm the model and retry. It is disarmed the instant any token
// arrives — a turn that is actually generating is never interrupted.
class StreamWatchdog {
  private heartbeat?: ReturnType<typeof setInterval>;
  private hardCap?: ReturnType<typeof setTimeout>;
  private readonly startedAt = Date.now();
  private _firedAbort = false;
  private disarmed = false;

  constructor(callbacks: StreamCallbacks, abort: () => void, heartbeatSec: number, timeoutSec: number, label: string) {
    if (heartbeatSec > 0) {
      this.heartbeat = setInterval(() => {
        if (this.disarmed) return;
        const s = Math.round((Date.now() - this.startedAt) / 1000);
        callbacks.onNotice?.(`Still waiting for ${label} — the model is likely loading into VRAM (${s}s elapsed).`);
      }, heartbeatSec * 1000);
    }
    if (timeoutSec > 0) {
      this.hardCap = setTimeout(() => {
        if (this.disarmed) return;
        this._firedAbort = true;
        abort();
      }, timeoutSec * 1000);
    }
  }

  // Call when the first token arrives — stops all timers and prevents any abort.
  disarm(): void { this.disarmed = true; this.stop(); }
  // Clear timers (idempotent). Always call on every turn-exit path.
  stop(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    if (this.hardCap) { clearTimeout(this.hardCap); this.hardCap = undefined; }
  }
  // True only when the hard cap fired (vs. a user esc / normal end).
  get firedAbort(): boolean { return this._firedAbort; }
}

// Reasoning is shown live but must NOT be stored in history (it bloats context
// and confuses the model on the next turn).
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
}

let _isOllamaCache: boolean | null = null;
async function checkOllama(baseUrl: string): Promise<boolean> {
  if (_isOllamaCache !== null) return _isOllamaCache;
  try {
    _isOllamaCache = await isOllama(baseUrl);
  } catch {
    // Transient error/timeout: don't cache 'false' so we can retry next time
    return false;
  }
  return _isOllamaCache;
}

async function* ollamaStream(params: any, signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  
  // Pair each tool result with the function it answered. Ollama's chat templates
  // — gpt-oss / harmony especially — need a tool result to be a proper `tool`
  // message tied to its call. Sending it as a plain `user` message (while the
  // assistant message still carries the `tool_calls`) leaves the conversation
  // with "unanswered" tool calls, so the model eventually returns an EMPTY turn
  // when it should finalize — it still thinks it's waiting on tools. This is the
  // real cause of the intermittent empties, and the fix works for every model.
  const toolNameById = new Map<string, string>();
  for (const m of params.messages as any[]) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id && tc.function?.name) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const mappedMessages = params.messages.map((m: any) => {
    if (m.role === "assistant" && m.tool_calls) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc: any) => {
          if (tc.function && typeof tc.function.arguments === "string") {
            try {
              return {
                ...tc,
                function: {
                  ...tc.function,
                  arguments: JSON.parse(tc.function.arguments),
                },
              };
            } catch {
              // leave arguments as the raw string if it isn't valid JSON
            }
          }
          return tc;
        }),
      };
    }
    if (m.role === "tool") {
      const name = toolNameById.get(m.tool_call_id);
      return {
        role: "tool",
        content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
        ...(name ? { tool_name: name } : {}),
      };
    }
    return m;
  });

  // Enable reasoning for thinking-capable models so their <think> stream is
  // visible (and counts as progress) instead of looking frozen.
  const caps = await modelCapabilities(cfg.baseUrl, cfg.model);
  const ollamaParams: any = {
    model: params.model,
    messages: mappedMessages,
    tools: params.tools,
    stream: true,
    options: {
      num_ctx: cfg.contextWindow,
      temperature: params.temperature ?? cfg.temperature,
      num_predict: params.max_tokens ?? cfg.maxTokens,
    }
  };
  if (caps.includes("thinking")) ollamaParams.think = cfg.thinking !== false;
  // Optional VRAM/CPU tuning: keep the model resident longer, control GPU
  // layers, control CPU threads.
  if (cfg.keepAlive) ollamaParams.keep_alive = cfg.keepAlive;
  if (typeof cfg.numGpu === "number") ollamaParams.options.num_gpu = cfg.numGpu;
  if (typeof cfg.numThread === "number") ollamaParams.options.num_thread = cfg.numThread;

  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaParams),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama native API returned ${res.status}: ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Response body is not readable.");

  const decoder = new TextDecoder();
  let buffer = "";
  let inThinking = false; // wrap streamed reasoning in <think>…</think>

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line);
        // Merge Ollama's separate `thinking` field into the content stream as
        // <think>…</think> so the existing reasoning UI dims it and it counts
        // toward live progress.
        let content = "";
        const thinking = json.message?.thinking;
        const realContent = json.message?.content;
        if (thinking) { if (!inThinking) { content += "<think>"; inThinking = true; } content += thinking; }
        if (realContent) { if (inThinking) { content += "</think>"; inThinking = false; } content += realContent; }
        if (json.done && inThinking) { content += "</think>"; inThinking = false; }
        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk" as const,
          created: Math.floor(Date.now() / 1000),
          model: params.model,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                content: content || null,
                tool_calls: json.message?.tool_calls?.map((tc: any, i: number) => ({
                  index: i,
                  id: tc.id ?? `call_${Date.now()}_${i}`,
                  type: "function",
                  function: {
                    name: tc.function?.name,
                    arguments: typeof tc.function?.arguments === "string" 
                      ? tc.function.arguments 
                      : JSON.stringify(tc.function?.arguments ?? {}),
                  }
                })) ?? null,
              }
            }
          ]
        } as ChatCompletionChunk;
        // Ollama's final message carries real token counts + timing.
        if (json.done) {
          // eval_duration is in nanoseconds; guard against 0/absurd values that
          // would make tok/s explode (we once showed "1000000 t/s").
          const dur = json.eval_duration;
          let tps = json.eval_count && dur && dur > 0 ? json.eval_count / (dur / 1e9) : 0;
          if (!Number.isFinite(tps) || tps < 0 || tps > 100000) tps = 0;
          (chunk as any).usage = {
            prompt_tokens: json.prompt_eval_count ?? 0,
            completion_tokens: json.eval_count ?? 0,
            tok_per_sec: tps,
          };
        }
        yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Open a streaming completion, retrying once on a transient connection error
// (e.g. the first request that triggers a slow cold model load).
async function createStream(params: any, signal?: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
  const cfg = getConfig();
  const isOll = await checkOllama(cfg.baseUrl);

  const open = async (): Promise<AsyncIterable<ChatCompletionChunk>> => {
    if (isOll) {
      return ollamaStream(params, signal);
    } else {
      // Messages may carry Ollama-style `images` (base64) — convert them to the
      // OpenAI content-parts format for non-Ollama endpoints.
      const messages = params.messages.map((m: any) =>
        m.role === "user" && Array.isArray(m.images) && m.images.length
          ? {
              role: "user",
              content: [
                { type: "text", text: typeof m.content === "string" ? m.content : "" },
                ...m.images.map((b: string) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b}` } })),
              ],
            }
          : m
      );
      const client = getClient();
      return client.chat.completions.create({ ...params, messages }, { signal }) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>;
    }
  };

  try {
    return await open();
  } catch (err: any) {
    if (/does not support tools/i.test(String(err?.message))) throw err;
    if (isTransient(err) && !signal?.aborted) {
      await sleep(1500);
      return await open();
    }
    throw err;
  }
}

// Load the model into memory ahead of the first real message so the cold load
// (which can take many seconds) doesn't drop a streaming connection.
// IMPORTANT: for Ollama this must use the SAME endpoint and options (num_ctx,
// num_gpu, keep_alive) as the real chats — Ollama keys the loaded runner on
// those, so warming through /v1 with default options made it load the model
// TWICE (once for the warm-up, again for the first real message).
export async function warmUp(): Promise<void> {
  try {
    const cfg = getConfig();
    if (await checkOllama(cfg.baseUrl)) {
      const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
      const body: any = {
        model: cfg.model,
        messages: [], // empty messages = "just load the model"
        options: { num_ctx: cfg.contextWindow },
      };
      if (cfg.keepAlive) body.keep_alive = cfg.keepAlive;
      if (typeof cfg.numGpu === "number") body.options.num_gpu = cfg.numGpu;
      if (typeof cfg.numThread === "number") body.options.num_thread = cfg.numThread;
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await res.text().catch(() => {});
      return;
    }
    await getClient().chat.completions.create({
      model: cfg.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    });
  } catch {
    /* best effort */
  }
}

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onToolCall: (name: string, args: string) => void;
  onToolResult: (name: string, result: string) => void;
  onError: (err: Error) => void;
  // One-off informational notices (e.g. falling back to prompted tool-calling).
  onNotice?: (msg: string) => void;
  // Real token usage for a turn (from Ollama's response): input/output + speed.
  onUsage?: (u: { inputTokens: number; outputTokens: number; tokPerSec: number }) => void;
  // Live progress while streaming: estimated output tokens generated so far
  // (counts hidden tool-call output too, so the UI shows activity throughout).
  onProgress?: (outTokensEstimate: number) => void;
  // What the model is doing RIGHT NOW, so the UI can tell "loading the model
  // into memory" apart from "reading the prompt" apart from "generating" —
  // instead of one ambiguous spinner. Fires at the start of each turn and again
  // when the first token arrives.
  onStatus?: (phase: "loading" | "prefill" | "generating") => void;
  // Return false to deny a tool call. Mutating tools route through here.
  // May also return { args } to apply a USER-MODIFIED version of the call
  // (e.g. only the diff hunks they selected in the permission prompt).
  requestPermission?: (name: string, args: any) => Promise<boolean | { args: any }>;
  // Ask the user to pick from options (the ask_user tool). Returns their answer.
  requestChoice?: (question: string, options: string[]) => Promise<string>;
}

export interface ChatOptions {
  signal?: AbortSignal;
  planMode?: boolean;   // block mutating tools (research only)
  autoAccept?: boolean; // skip permission prompts
}

// Tools that change disk / run arbitrary code.
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "bash", "run_server", "stop_server", "update_profile", "kill_port", "browser_open", "browser_click", "browser_type", "screenshot", "page_click", "page_type", "page_open", "page_navigate", "spawn_agents"]);
// Read-only tools — safe to run in parallel (e.g. reading many files at once).
const READONLY_TOOLS = new Set(["read_file", "glob_files", "grep_files", "list_dir", "server_logs", "list_servers", "read_profile", "list_ports", "system_info", "recall", "task_list", "browser_console", "browser_network", "browser_performance"]);
const MAX_ITERATIONS = 50;

// Cache tool-support detection and 400-fallbacks per baseUrl::model.
const toolSupportCache = new Map<string, boolean>();
const forcedPrompted = new Set<string>();
const noticed = new Set<string>();

function key(): string {
  const cfg = getConfig();
  return `${cfg.baseUrl}::${cfg.model}`;
}

async function resolveUseNative(callbacks: StreamCallbacks): Promise<boolean> {
  const cfg = getConfig();
  if (cfg.toolMode === "native") return true;
  if (cfg.toolMode === "prompted") { notifyPrompted(callbacks); return false; }
  const k = key();
  if (forcedPrompted.has(k)) { notifyPrompted(callbacks); return false; }
  if (toolSupportCache.has(k)) {
    const v = toolSupportCache.get(k)!;
    if (!v) notifyPrompted(callbacks);
    return v;
  }
  const supported = await detectToolSupport(cfg.baseUrl, cfg.model);
  const useNative = supported !== false; // null (unknown) → assume native
  toolSupportCache.set(k, useNative);
  if (!useNative) notifyPrompted(callbacks);
  return useNative;
}

function notifyPrompted(callbacks: StreamCallbacks) {
  const k = key();
  if (noticed.has(k)) return;
  noticed.add(k);
  callbacks.onNotice?.(`"${getConfig().model}" has no native tool support — using prompted tool-calling.`);
}

// At the start of each turn, check Ollama's /api/ps to tell the UI whether the
// model still has to be LOADED into memory (cold start — looks frozen otherwise)
// or is already resident (so the wait is prompt prefill). While we're at it,
// warn ONCE per model when it doesn't fully fit in VRAM — partial CPU offload
// is the silent killer of tokens/sec on small GPUs.
const vramNoticed = new Set<string>();

async function reportTurnStart(callbacks: StreamCallbacks): Promise<void> {
  if (!callbacks.onStatus) return;
  const cfg = getConfig();
  try {
    if (await checkOllama(cfg.baseUrl)) {
      const loaded = await loadedModels(cfg.baseUrl);
      const base = cfg.model.split(":")[0]!;
      const m = loaded.find(x => x.name === cfg.model) ?? loaded.find(x => x.name.startsWith(base));
      if (!m) { callbacks.onStatus("loading"); return; }
      if (m.size && m.sizeVram !== undefined && m.sizeVram < m.size && !vramNoticed.has(cfg.model)) {
        vramNoticed.add(cfg.model);
        const pct = Math.round((m.sizeVram / m.size) * 100);
        const gb = (n: number) => (n / 1e9).toFixed(1);
        callbacks.onNotice?.(
          `"${cfg.model}" doesn't fully fit in VRAM — only ${pct}% is on the GPU (${gb(m.sizeVram)} of ${gb(m.size)} GB); the rest runs from system RAM, which slows generation a lot. ` +
          `To fit it: lower the context window (it's the KV cache that grows with num_ctx), use a smaller quant (e.g. q4_K_M), or switch to a smaller model.`
        );
      }
    }
  } catch { /* status is best-effort */ }
  callbacks.onStatus("prefill");
}

// Shared policy gate: plan-mode block, permission, execution. Returns result.
async function runTool(
  name: string,
  args: any,
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<string> {
  // ask_user is interactive, not an action: pause and let the user pick. Allowed
  // in every mode (asking never changes anything).
  if (name === "ask_user") {
    const question = String(args?.question ?? "").trim() || "Please choose:";
    let opts: string[] = Array.isArray(args?.options)
      ? args.options.map((o: any) => String(o)).filter(Boolean)
      : typeof args?.options === "string"
        ? args.options.split(/\||\n/).map((o: string) => o.trim()).filter(Boolean)
        : [];
    if (opts.length === 0) opts = ["Yes", "No"];
    let answer = opts[0]!;
    if (callbacks.requestChoice) {
      try { answer = await callbacks.requestChoice(question, opts); } catch { /* keep default */ }
    }
    const r = `The user answered "${answer}" to: ${question}`;
    callbacks.onToolResult(name, r);
    return r;
  }

  if (options.planMode && MUTATING_TOOLS.has(name)) {
    const r = `[plan mode] ${name} is blocked. You are planning, not executing — present your plan and wait for approval.`;
    callbacks.onToolResult(name, r);
    return r;
  }
  if (MUTATING_TOOLS.has(name) && !options.autoAccept && callbacks.requestPermission) {
    // Skip the prompt for tools the user permanently allowed (Always allow / 'a').
    const persisted = getConfig().alwaysAllow ?? [];
    if (!persisted.includes(name)) {
      const approved = await callbacks.requestPermission(name, args);
      if (!approved) {
        const r = "Tool call denied by user.";
        callbacks.onToolResult(name, r);
        return r;
      }
      // Partial approval: the user selected a subset of the diff's hunks.
      if (typeof approved === "object" && approved.args) args = approved.args;
    }
  }
  let result: string;
  try {
    result = await executeTool(name, args);
  } catch (e: any) {
    result = `Error: ${e.message}`;
  }
  callbacks.onToolResult(name, result);
  return result;
}

export interface NormCall { id?: string; name: string; args: any; rawArgs: string; }

// Execute a turn's tool calls. Read-only calls run concurrently (so the agent
// can read/search many files at once); mutating calls run sequentially so
// permission prompts + diffs are shown one at a time. Callbacks fire per call in
// the original order, and results are returned in that order.
async function executeCalls(
  calls: NormCall[],
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<{ id?: string; name: string; result: string }[]> {
  // Kick off all read-only calls in parallel.
  const preRun = new Map<number, string>();
  await Promise.all(calls.map(async (c, i) => {
    if (!READONLY_TOOLS.has(c.name)) return;
    try { preRun.set(i, await executeTool(c.name, c.args)); }
    catch (e: any) { preRun.set(i, `Error: ${e.message}`); }
  }));

  const out: { id?: string; name: string; result: string }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    callbacks.onToolCall(c.name, c.rawArgs);
    let result: string;
    if (preRun.has(i)) {
      result = preRun.get(i)!;
      callbacks.onToolResult(c.name, result);
    } else {
      result = await runTool(c.name, c.args, callbacks, options);
    }
    out.push({ id: c.id, name: c.name, result });
  }
  return out;
}

// Weak models (e.g. gemma) often ANNOUNCE an action and then end the turn without
// calling any tool — "First, I'll look for the config files." — and repeat it. We
// nudge them to actually act (a few times), then stop with a clear notice instead
// of leaving the user staring at a stalled chat.
const INTENT_RE = /\b(i['’]?\s*(?:will|ll|'?m going to)|let me|first,?\s*i)\b[\s\S]{0,80}?\b(look|check|find|search|read|examine|inspect|create|write|run|fix|update|add|modify|explore|list)\b/i;
// Chatty models (e.g. deepseek-coder-v2:lite) stall with filler instead of the
// "I will <verb>" shape INTENT_RE catches — "give me a moment", "please hold on
// while I perform this step", "let me do that". Treat these as a stall too.
const STALL_FILLER_RE = /\b(give me a moment|one moment|hold on|please hold|bear with me|please wait|in a moment|momentarily|stand by|let me (?:do|perform|run|start|handle) (?:this|that|it|these)|i['’]?ll (?:perform|do|run|start|handle) (?:this|that|these|it|the)|perform (?:this step|these actions|this action))\b/i;
// Worse failure mode: the model reverts to a passive-chatbot refusal prior and
// claims it has no tools ("as an AI I don't have the capability to start a
// server"). It needs a correction, not just a "do it" nudge.
const REFUSAL_RE = /\b(as an ai|i (?:do not|don['’]?t) have (?:the )?(?:ability|capability|capabilities|access)|i['’]?m (?:unable|not able) to|i am (?:unable|not able) to|i cannot (?:perform|execute|run|start|access|open|create|do)|i can['’]?t (?:perform|execute|run|start|access|open|create|do))\b/i;
const STALL_NUDGE = "You said what you WOULD do but did not do it. Do not explain or repeat yourself — issue the tool call right now (glob_files, list_dir, read_file, write_file, edit_file, bash, run_server, …). If there is genuinely nothing left to do, give the final result.";
const REFUSAL_NUDGE = "You are NOT a passive chat assistant — you are an agent running on the user's machine with REAL tools, and you DO have the ability to act. You can start servers (run_server), run shell commands (bash), and read/write files. Stop apologizing and stop claiming you can't — issue the actual tool call now. For example, to start a dev server emit a run_server call with the start command (e.g. command=\"npm run dev\"). Do NOT describe what the user should do; do it yourself with a tool.";
// Third stall shape: LECTURE mode. The model answers a bug report with advice
// and example snippets for the USER to apply ("you need to configure…", "here's
// how you can…", "please start the server") instead of touching anything. All
// of these phrasings delegate work to the user, which the system prompt forbids
// — so matching them when NO tool ran is a reliable signal, not a guess.
const ADVICE_RE = /\b(you (?:need|will need|would need|should|must|['’]?ll want) to \w+|you can (?:do this|add|use|fix|install|configure|set ?up|create|modify|edit|update|include|run) |here['’]?s how you can|please (?:check|ensure|verify|make sure) (?:if |that )?you|please (?:start|restart|run|install|execute) (?:the|a|your|it)\b|make sure (?:you|your) )/i;
const ADVICE_NUDGE = "STOP. You just gave the user instructions and/or example code instead of doing the work. The user does NOT apply fixes — YOU do, with your tools, on the real files. Investigate now (read_file / grep_files / list_dir), make the actual change (edit_file / write_file), run what needs running (bash / run_server), and verify it yourself. Never print a snippet for the user to copy and never tell them to configure anything. Issue the first tool call immediately.";

function lastAssistantText(history: ChatCompletionMessageParam[]): { text: string; hadToolCalls: boolean } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      return { text, hadToolCalls: !!(m as any).tool_calls?.length };
    }
  }
  return null;
}

function checkToolLoop(
  norm: NormCall[],
  results: { name: string; result: string }[],
  toolLoopGuard?: ToolLoopGuard
): boolean {
  if (!toolLoopGuard) return false;
  let detected = false;
  for (let i = 0; i < norm.length; i++) {
    const call = norm[i];
    if (call && toolLoopGuard.record(call.name, call.args, results[i]?.result ?? "")) {
      detected = true;
    }
  }
  return detected;
}

export async function chat(
  messages: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions = {}
): Promise<ChatCompletionMessageParam[]> {
  const history = [...messages];
  let useNative = await resolveUseNative(callbacks);
  let iteration = 0;
  let stallNudges = 0;
  let emptyRetries = 0;
  const toolLoopGuard = new ToolLoopGuard();

  const handleDone = (): "break" | "continue" => {
    const last = lastAssistantText(history);
    // Only intervene if the model produced text and called NO tool. Four stall
    // shapes: announcing an action ("I'll check…"), filler ("give me a moment"),
    // a passive-chatbot refusal ("as an AI I can't start a server"), or lecture
    // mode (telling the USER how to fix it / printing snippets to copy). Each
    // gets a correction matched to its failure.
    if (last && !last.hadToolCalls && last.text.trim().length > 20) {
      const refusing = REFUSAL_RE.test(last.text);
      const advising = !refusing && ADVICE_RE.test(last.text);
      const stalling = refusing || advising || INTENT_RE.test(last.text) || STALL_FILLER_RE.test(last.text);
      if (stalling) {
        if (stallNudges < 2) {
          history.push({ role: "user", content: refusing ? REFUSAL_NUDGE : advising ? ADVICE_NUDGE : STALL_NUDGE });
          stallNudges++;
          return "continue";
        }
        callbacks.onNotice?.("The model keeps stalling — announcing actions, refusing, or telling YOU how to fix things instead of using its tools. This model struggles with agentic work — switch to a stronger model like qwen2.5-coder (use /model).");
      }
    }
    return "break";
  };

  // An empty turn (no text, no tool call) is NOT about size: Ollama slides num_ctx
  // for a long prompt, so an over-full context truncates silently rather than
  // coming back empty, and the model is resident regardless of a CPU/GPU split.
  // It's a transient protocol hiccup on this turn (the main cause — unpaired tool
  // results — is fixed in ollamaStream). Escalating, non-destructive remedy:
  //   1st empty → just retry; most clear on a second attempt.
  //   2nd empty → NUDGE it (change the input) to continue — more effective than
  //               another identical retry for a reasoning model that stalled.
  //   3rd empty → stop and let the user resend (no blaming the model/hardware).
  // `emptyRetries` counts CONSECUTIVE empties and is reset to 0 by any productive
  // turn (see the loop) — so scattered empties during a long, otherwise-healthy
  // task never accumulate into a false give-up. Never compact: shrinking history
  // can't fix a problem that has nothing to do with its size.
  const handleEmpty = async (): Promise<"break" | "continue"> => {
    emptyRetries++;
    if (emptyRetries === 1) {
      // Just retry — most empties clear on a second attempt.
      callbacks.onNotice?.("Empty response — retrying…");
      await sleep(400);
      return "continue";
    }
    if (emptyRetries === 2) {
      // Nudge: change the input so a reasoning model that "thought" itself into
      // nothing has a concrete instruction to act on.
      callbacks.onNotice?.("Still empty — nudging the model to continue.");
      history.push({ role: "user", content: "[automatic notice — not typed by the user] Your last turn produced no output at all (no text and no tool call). Continue the task now: either issue the next tool call, or give your final answer. Do not reply with an empty message." });
      return "continue";
    }
    // Give up only after retry + nudge both failed. This is a protocol hiccup on
    // this turn, NOT a limit of the model or hardware — so we don't tell the user
    // to shrink anything; just resend.
    callbacks.onNotice?.("The model returned an empty response several times in a row even after retrying and nudging. This is usually a one-off hiccup on this turn — resend your message. If it keeps happening with this model, turning reasoning off can help (/config thinking false).");
    return "break";
  };

  while (iteration++ < MAX_ITERATIONS) {
    if (options.signal?.aborted) break;

    // Console/error streaming: surface error lines that background servers
    // emitted since the last check, so the agent sees runtime/build failures
    // WITHOUT having to ask for server_logs.
    const srvErrs = drainServerErrors();
    if (srvErrs.length > 0) {
      const block = srvErrs.map(e =>
        `Background server [${e.id}] ("${e.command}") emitted error output:\n${e.lines.slice(-15).map(l => `  ${l}`).join("\n")}`
      ).join("\n\n");
      history.push({
        role: "user",
        content: `[automatic notice — not typed by the user]\n${block}\n\nIf these errors are caused by your recent changes, fix them now (use server_logs id="${srvErrs[0]!.id}" for full context). Otherwise continue your current task and mention them in your summary.`,
      });
      callbacks.onNotice?.(`Detected error output from ${srvErrs.map(e => `[${e.id}]`).join(", ")} — passing it to the model.`);
    }

    if (useNative) {
      const outcome = await nativeTurn(history, callbacks, options, toolLoopGuard);
      if (outcome !== "empty") emptyRetries = 0; // a productive turn clears the streak
      if (outcome === "fallback") {
        // Server rejected tools mid-flight — switch to prompted and retry turn.
        forcedPrompted.add(key());
        toolSupportCache.set(key(), false);
        notifyPrompted(callbacks);
        useNative = false;
        iteration--;
        continue;
      }
      if (outcome === "loop_detected") {
        break;
      }
      if (outcome === "empty") { if (await handleEmpty() === "break") break; else continue; }
      if (outcome === "done") { if (handleDone() === "break") break; else continue; }
      // otherwise "continue" (tools ran) → loop
    } else {
      const outcome = await promptedTurn(history, callbacks, options, toolLoopGuard);
      if (outcome !== "empty") emptyRetries = 0; // a productive turn clears the streak
      if (outcome === "loop_detected") {
        break;
      }
      if (outcome === "empty") { if (await handleEmpty() === "break") break; else continue; }
      if (outcome === "done") { if (handleDone() === "break") break; else continue; }
    }
  }

  return history;
}

// ─── Native tool-calling turn ─────────────────────────────────────────────────
type NativeOutcome = "done" | "continue" | "fallback" | "loop_detected" | "empty";

async function nativeTurn(
  history: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions,
  toolLoopGuard?: ToolLoopGuard
): Promise<NativeOutcome> {
  const cfg = getConfig();
  let assistantText = "";
  let genChars = 0;
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const providerToInternalIndex = new Map<number, number>();
  // Hide tool calls the model PRINTS as ```json blocks (qwen-coder does this) from
  // the live display, while keeping the full text for parsing/the fallback.
  const narr = new NarrationFilter();
  const harmony = new HarmonyFilter();     // route <|channel|>… (gemma/gpt-oss): analysis→think, drop tool narration
  const rep = new RepetitionGuard();       // stop degenerate repeat loops (opt-in)
  const guardOn = cfg.loopGuard === true;
  let looped = false;
  let firstToken = true;

  const wdAc = linkAbort(options.signal);
  const wd = new StreamWatchdog(callbacks, () => wdAc.abort(), cfg.stallHeartbeatSec, cfg.stallTimeoutSec, "the model's response");

  try {
    await reportTurnStart(callbacks);
    const stream = await createStream(
      {
        model: cfg.model,
        messages: history,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: true,
      },
      wdAc.signal
    );

    for await (const chunk of stream) {
      if (wdAc.signal.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, tokPerSec: u.tok_per_sec });
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (firstToken && (delta.content || delta.tool_calls)) { firstToken = false; wd.disarm(); callbacks.onStatus?.("generating"); }
      if (delta.content) {
        const clean = harmony.push(delta.content);
        if (clean) {
          assistantText += clean; genChars += clean.length;
          if (guardOn && rep.push(clean)) looped = true;
          const visible = narr.push(clean);
          if (visible) callbacks.onText(visible);
          if (looped) break;
        }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const providerIdx = tc.index ?? 0;
          let internalIdx = providerToInternalIndex.get(providerIdx);
          if (internalIdx !== undefined) {
            const currentEntry = toolCallsByIndex.get(internalIdx);
            if (currentEntry) {
              const hasArgs = currentEntry.args.length > 0;
              const gotNewId = tc.id && tc.id !== currentEntry.id;
              const gotNewName = tc.function?.name && hasArgs;
              if (gotNewId || gotNewName) {
                internalIdx = toolCallsByIndex.size;
                providerToInternalIndex.set(providerIdx, internalIdx);
              }
            }
          } else {
            internalIdx = providerIdx;
            providerToInternalIndex.set(providerIdx, internalIdx);
          }

          let entry = toolCallsByIndex.get(internalIdx);
          if (!entry) {
            entry = { id: tc.id || `call_${Date.now()}_${internalIdx}`, name: "", args: "" };
            toolCallsByIndex.set(internalIdx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments;
            genChars += tc.function.arguments.length;
          }
        }
      }
      callbacks.onProgress?.(Math.round(genChars / 4));
    }
    if (!looped) {
      const hTail = harmony.flush();
      if (hTail) { assistantText += hTail; const v = narr.push(hTail); if (v) callbacks.onText(v); }
    }
    const tail = narr.flush();
    if (tail) callbacks.onText(tail);
  } catch (err: any) {
    wd.stop();
    const msg = String(err?.message ?? err);
    if (/does not support tools/i.test(msg) || /tools.*not supported/i.test(msg)) return "fallback";
    // The watchdog aborted a stalled turn (no token within the cap) — retryable,
    // not a user stop. chat()'s handleEmpty warms the model and retries.
    if (wd.firedAbort && !options.signal?.aborted) return "empty";
    if (err?.name === "AbortError") return "done";
    callbacks.onError(err);
    return "done";
  }
  wd.stop();

  // The model got stuck repeating itself — stop the turn cleanly instead of
  // letting it burn thousands of tokens, and keep history small.
  if (looped) {
    callbacks.onNotice?.("Stopped: the model was repeating itself. The task may already be done — check the result. If it keeps looping, try /compact, or switch to a stronger code model (e.g. qwen2.5-coder).");
    const kept = stripThink(assistantText).slice(0, 1500);
    history.push({ role: "assistant", content: kept || "(response stopped — the model was repeating itself)" });
    return "done";
  }

  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter(tc => tc.name);

  const storedText = stripThink(assistantText);

  // No tool call and no final answer. NOT a context-size problem (Ollama
  // truncates an over-long prompt silently; it doesn't return empty). Two real
  // shapes, each handled distinctly:
  if (toolCalls.length === 0 && !storedText) {
    // (a) The stream produced nothing at all → transient (model still loading
    //     into VRAM, or the server was momentarily overloaded). Record no turn
    //     and let chat() retry.
    if (!assistantText) return "empty";
    // (b) Reasoning only: the model spent its whole output budget thinking and
    //     never answered. Record the (empty) turn so callers don't misread it as
    //     a dropped response, and point at the real fix.
    history.push({ role: "assistant", content: "" });
    callbacks.onNotice?.("The model reasoned for the entire turn but never produced an answer — it most likely ran out of output tokens mid-thought. Raise the limit (/config maxTokens <n>) or switch to a non-reasoning model.");
    return "done";
  }

  history.push({
    role: "assistant",
    content: storedText || null,
    ...(toolCalls.length > 0 ? {
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
    } : {}),
  });

  if (toolCalls.length === 0) {
    // Some models (notably qwen-coder) emit a tool call as text — a ```json
    // block or an XML tag — instead of using the native tool_calls field, so the
    // SDK reports none. Parse the content and run them as a fallback, feeding the
    // results back as a user message (prompted style) so the loop continues.
    const parsed = parseToolCalls(storedText);
    if (parsed.length > 0) {
      const norm: NormCall[] = parsed.map(c => ({ name: canonicalToolName(c.name), args: c.arguments, rawArgs: JSON.stringify(c.arguments) }));
      const results = await executeCalls(norm, callbacks, options);
      const responses = results.map(r => `<tool_response name="${r.name}">\n${r.result}\n</tool_response>`);
      history.push({
        role: "user",
        content: `${responses.join("\n")}\n\nContinue: issue the next tool call, or give your final response. Prefer the native tool-call interface over writing tool calls as text.`,
      });
      if (checkToolLoop(norm, results, toolLoopGuard)) {
        callbacks.onNotice?.("Stopped: the model was stuck in an infinite tool-calling loop (e.g. executing the same actions with the same results repeatedly). Switch to a stronger model, or change your prompt.");
        return "loop_detected";
      }
      return "continue";
    }
    return "done";
  }

  const norm: NormCall[] = toolCalls.map(tc => {
    let args: any = {};
    try { args = JSON.parse(tc.args || "{}"); } catch {}
    return { id: tc.id, name: canonicalToolName(tc.name), args, rawArgs: tc.args };
  });
  const results = await executeCalls(norm, callbacks, options);
  for (const r of results) history.push({ role: "tool", tool_call_id: r.id!, content: r.result });
  if (checkToolLoop(norm, results, toolLoopGuard)) {
    callbacks.onNotice?.("Stopped: the model was stuck in an infinite tool-calling loop (e.g. executing the same actions with the same results repeatedly). Switch to a stronger model, or change your prompt.");
    return "loop_detected";
  }
  return "continue";
}

// ─── Prompted tool-calling turn (no native function support) ──────────────────
type PromptedOutcome = "done" | "continue" | "loop_detected" | "empty";

async function promptedTurn(
  history: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions,
  toolLoopGuard?: ToolLoopGuard
): Promise<PromptedOutcome> {
  const cfg = getConfig();

  // Build request messages: augment the system message with tool instructions
  // (request-only — the stored history keeps the clean system prompt).
  const request = augmentSystem(history, promptedToolInstructions());

  let raw = "";
  const prose = new ProseFilter();
  const rep = new RepetitionGuard();
  const guardOn = cfg.loopGuard === true;
  let looped = false;
  let firstToken = true;

  const wdAc = linkAbort(options.signal);
  const wd = new StreamWatchdog(callbacks, () => wdAc.abort(), cfg.stallHeartbeatSec, cfg.stallTimeoutSec, "the model's response");

  try {
    await reportTurnStart(callbacks);
    const stream = await createStream(
      {
        model: cfg.model,
        messages: request,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: true,
      },
      wdAc.signal
    );

    for await (const chunk of stream) {
      if (wdAc.signal.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, tokPerSec: u.tok_per_sec });
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content;
      if (!text) continue;
      if (firstToken) { firstToken = false; wd.disarm(); callbacks.onStatus?.("generating"); }
      raw += text;
      callbacks.onProgress?.(Math.round(raw.length / 4));
      // Show prose but hide raw tool-call markup; <think> is handled upstream.
      const visible = prose.push(text);
      if (visible) callbacks.onText(visible);
      if (guardOn && rep.push(text)) { looped = true; break; }
    }
    const tail = prose.flush();
    if (tail) callbacks.onText(tail);
  } catch (err: any) {
    wd.stop();
    // Watchdog aborted a stalled turn (no token within the cap) → retryable.
    if (wd.firedAbort && !options.signal?.aborted) return "empty";
    if (err?.name === "AbortError") return "done";
    callbacks.onError(err);
    return "done";
  }
  wd.stop();

  if (looped) {
    callbacks.onNotice?.("Stopped: the model was repeating itself. The task may already be done — check the result. If it keeps looping, try /compact, or switch to a stronger code model (e.g. qwen2.5-coder).");
    history.push({ role: "assistant", content: stripThink(raw).slice(0, 1500) || "(response stopped — the model was repeating itself)" });
    return "done";
  }

  // Nothing streamed at all → transient (model loading / overloaded). Let chat()
  // retry; this is not a context-size problem (see handleEmpty).
  if (!raw.trim()) return "empty";

  // Strip reasoning before parsing/storing (shown live, not kept in history).
  const cleanRaw = stripThink(raw);

  // Reasoning only (raw was all <think>…</think>): nothing to act on. Record the
  // turn and explain the real cause rather than blaming context size.
  if (!cleanRaw) {
    history.push({ role: "assistant", content: "" });
    callbacks.onNotice?.("The model reasoned for the entire turn but never produced an answer — it most likely ran out of output tokens mid-thought. Raise the limit (/config maxTokens <n>) or switch to a non-reasoning model.");
    return "done";
  }

  history.push({ role: "assistant", content: cleanRaw });

  const calls = parseToolCalls(cleanRaw);
  if (calls.length === 0) return "done"; // final answer

  const norm: NormCall[] = calls.map(call => ({ name: canonicalToolName(call.name), args: call.arguments, rawArgs: JSON.stringify(call.arguments) }));
  const results = await executeCalls(norm, callbacks, options);
  const responses = results.map(r => `<tool_response name="${r.name}">\n${r.result}\n</tool_response>`);
  history.push({
    role: "user",
    content: `${responses.join("\n")}\n\nPlease analyze the tool output. Output the next tool call, or if you are done, provide a final response summarizing the changes or results for the user.`,
  });
  if (checkToolLoop(norm, results, toolLoopGuard)) {
    callbacks.onNotice?.("Stopped: the model was stuck in an infinite tool-calling loop (e.g. executing the same actions with the same results repeatedly). Switch to a stronger model, or change your prompt.");
    return "loop_detected";
  }
  return "continue";
}

// Clone messages, appending `extra` to the system message (or inserting one).
function augmentSystem(messages: ChatCompletionMessageParam[], extra: string): ChatCompletionMessageParam[] {
  const out = messages.map(m => ({ ...m }));
  const sys = out.find(m => m.role === "system");
  if (sys && typeof sys.content === "string") {
    sys.content = sys.content + extra;
  } else {
    out.unshift({ role: "system", content: extra.trimStart() });
  }
  return out;
}

// ─── Token estimation & compaction ────────────────────────────────────────────
// Base64 images on messages would count as ~1 token per 4 chars (wildly wrong);
// exclude them and charge a flat vision-token estimate per image instead.
export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let images = 0;
  const json = JSON.stringify(messages, (k, v) => {
    if (k === "images" && Array.isArray(v)) { images += v.length; return undefined; }
    return v;
  });
  return Math.round(json.length / 4) + images * 768;
}

export async function summarizeConversation(messages: ChatCompletionMessageParam[]): Promise<string> {
  const cfg = getConfig();
  const client = getClient();
  const transcript = messages
    .filter(m => m.role !== "system")
    .map(m => {
      let content = typeof m.content === "string" ? m.content : "";
      if (m.role === "assistant" && (m as any).tool_calls?.length) {
        const calls = (m as any).tool_calls.map((t: any) => `${t.function.name}(${t.function.arguments})`).join(", ");
        content += `\n[called tools: ${calls}]`;
      }
      return `${m.role}: ${content}`;
    })
    .join("\n\n");

  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: "You compress a coding-session transcript into a concise but complete summary. Preserve the user's goals, decisions, files created/modified and how, key findings, current state, and unfinished next steps. Terse bullet points. Omit chit-chat." },
      { role: "user", content: `Summarize this coding session:\n\n${transcript}` },
    ],
    temperature: 0.3,
    max_tokens: 1024,
    stream: false,
  });
  return res.choices[0]?.message?.content?.trim() || "(summary unavailable)";
}

export function compactHistory(messages: ChatCompletionMessageParam[], summary: string, keep = 4): ChatCompletionMessageParam[] {
  const system = messages.find(m => m.role === "system");
  const nonSystem = messages.filter(m => m.role !== "system");
  let startIdx = Math.max(0, nonSystem.length - keep);
  while (startIdx < nonSystem.length && nonSystem[startIdx]?.role !== "user") startIdx++;
  const tail = nonSystem.slice(startIdx);
  const result: ChatCompletionMessageParam[] = [];
  if (system) result.push(system);
  result.push({ role: "user", content: `[Summary of earlier conversation, compacted to save context]\n${summary}` });
  result.push(...tail);
  return result;
}
