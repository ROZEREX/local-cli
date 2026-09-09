import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionChunk } from "openai/resources/chat/completions";
import { getConfig } from "./config";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { executeTool, canonicalToolName } from "./tools/executor";
import { isParallelSafeTool, requiresToolPermission } from "./tools/policy";
import { detectToolSupport, isOllama, detectProvider, modelCapabilities, loadedModels, type Provider } from "./ollama";
import { parseToolCalls, parseLeakedToolCall, ProseFilter, NarrationFilter } from "./toolparse";
import { RepetitionGuard, HarmonyFilter, ToolLoopGuard } from "./think";
import { promptedToolInstructions } from "./prompt";
import { drainServerErrors } from "./proc";
import { noteUserTurn, noteToolOutcome, buildRuntimeOverride, isAwaitingScaffold } from "./orchestrator-state";
import http from "node:http";
import https from "node:https";

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
  _providerCache = null;
}

// Connection errors worth one retry (cold model load can drop the socket).
function isTransient(err: any): boolean {
  if (err?.name === "AbortError") return false;
  const m = String(err?.message ?? err).toLowerCase();
  return ["socket", "econnreset", "connection", "terminated", "fetch failed", "network", "timeout", "timed out", "etimedout"].some(s => m.includes(s));
}

// The native /api/chat backend parses tool calls server-side from the model's
// output. Several local backends intermittently emit malformed/truncated tool-call
// JSON and reject the turn — NOT a missing-tools or model-capability problem:
//   - Ollama + gpt-oss/harmony:  "error parsing tool call" (e.g. raw='{"}')
//   - llama-server + Qwen3-Coder: "invalid tool call arguments for \"bash\":
//     unexpected end of JSON input" (the args object was cut off — common when the
//     model emits a big/multi-line command that its JSON encoder truncates).
// We detect all of these so we can retry once and then fall back to PROMPTED
// tool-calling, which never sends `tools` (so the server-side parser never runs)
// and passes bodies RAW — no JSON escaping to truncate. That fallback is the fix.
function isOllamaToolParseError(msg: string): boolean {
  return /parsing tool call/i.test(msg)
    || /invalid tool call arguments/i.test(msg)
    || /unexpected end of json/i.test(msg);
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
  // Whether the model is already resident: "prefill" means the wait is the model
  // crunching the prompt (GPU busy — compute, not a freeze); "loading" means it's
  // still being read into memory. Set once reportTurnStart() resolves.
  private phase: "loading" | "prefill" = "loading";

  setPhase(p: "loading" | "prefill"): void { this.phase = p; }

  constructor(callbacks: StreamCallbacks, abort: () => void, heartbeatSec: number, timeoutSec: number, label: string) {
    if (heartbeatSec > 0) {
      this.heartbeat = setInterval(() => {
        if (this.disarmed) return;
        const s = Math.round((Date.now() - this.startedAt) / 1000);
        const msg = this.phase === "prefill"
          ? `Still working — the model is processing the prompt (${s}s). The GPU is busy; this is compute, not a freeze. A large context window or a model that spills into system RAM makes this slow.`
          : `Still waiting — loading the model into memory (${s}s). A cold load of a large model can take a while.`;
        // Ephemeral pulse: refresh ONE live line, don't append a transcript entry
        // per tick. Fall back to onNotice only when onHeartbeat isn't implemented.
        if (callbacks.onHeartbeat) callbacks.onHeartbeat(msg, { phase: this.phase, elapsedSec: s });
        else callbacks.onNotice?.(msg);
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

// Normalize a turn's usage object for onUsage. Ollama supplies tok_per_sec from
// its own timing; OpenAI/vLLM only return token counts, so derive tok/s from how
// long generation took (genStartMs = when the first token arrived).
function toUsage(u: any, genStartMs: number): { inputTokens: number; outputTokens: number; tokPerSec: number } {
  const out = u.completion_tokens ?? 0;
  let tps = typeof u.tok_per_sec === "number"
    ? u.tok_per_sec
    : out > 0 && genStartMs > 0 ? out / ((Date.now() - genStartMs) / 1000) : 0;
  if (!Number.isFinite(tps) || tps < 0 || tps > 100000) tps = 0;
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: out, tokPerSec: tps };
}

// The output-token budget for a request. OpenAI servers (vLLM especially) reject
// the call when prompt_tokens + max_tokens exceeds the model context
// (max_model_len), so cap max_tokens to the room left in the context window
// instead of always sending cfg.maxTokens. The prompt estimate is padded since
// our char/4 estimate runs low on code. Ollama tolerates an oversized num_predict
// but clamping is harmless there too (you can't generate past the context).
// Rough token cost of the native tool schemas — they are part of the prompt for
// a native tool-calling turn, so they must be reserved against the context too.
const TOOLS_TOKEN_EST = Math.ceil(JSON.stringify(TOOL_DEFINITIONS).length / 4);

function outputBudget(messages: ChatCompletionMessageParam[], extraTokens = 0): number {
  const cfg = getConfig();
  const promptEst = Math.ceil((estimateTokens(messages) + extraTokens) * 1.15);
  const room = cfg.contextWindow - promptEst - 512;
  if (room < 256) throw new Error("Context budget exceeded. Reduce attachments or compact the conversation before continuing.");
  return Math.max(256, Math.min(cfg.maxTokens, room));
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

// Cache the detected backend (ollama / vllm / openai) for the active baseUrl.
// Cleared by resetClient() when baseUrl, apiKey, or provider changes.
let _providerCache: Provider | null = null;
async function checkProvider(): Promise<Provider> {
  if (_providerCache) return _providerCache;
  const cfg = getConfig();
  try {
    _providerCache = await detectProvider(cfg.baseUrl, cfg.provider);
  } catch {
    return cfg.provider !== "auto" ? cfg.provider : "openai"; // don't cache a guess
  }
  return _providerCache;
}

async function* streamOllamaRequest(urlStr: string, bodyJson: any, signal?: AbortSignal): AsyncGenerator<string> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  
  const postData = JSON.stringify(bodyJson);
  
  const agent = new lib.Agent({
    keepAlive: true,
    keepAliveMsecs: 5000, // Send TCP keep-alive probes every 5 seconds
  });

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
    agent,
  };

  const responsePromise = new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = lib.request(urlStr, options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let errData = "";
        res.on("data", (chunk) => { errData += chunk.toString(); });
        res.on("end", () => {
          reject(new Error(`Ollama native API returned ${res.statusCode}: ${errData}`));
        });
      } else {
        resolve(res);
      }
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      } else {
        const onAbort = () => {
          req.destroy();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => {
          signal.removeEventListener("abort", onAbort);
        });
      }
    }

    req.write(postData);
    req.end();
  });

  const res = await responsePromise;
  
  for await (const chunk of res) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    yield chunk.toString();
  }
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

  let buffer = "";
  let inThinking = false; // wrap streamed reasoning in <think>…</think>

  const urlStr = `${host}/api/chat`;
  const responseStream = streamOllamaRequest(urlStr, ollamaParams, signal);

  for await (const chunk of responseStream) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const json = JSON.parse(line);
        // Ollama can stream a 200 and then emit an error line mid-stream (e.g.
        // the harmony tool-call parser failing on gpt-oss). Surface it instead
        // of silently yielding empty chunks, so chat() can retry / fall back.
        if (json.error) throw new Error(`Ollama native API error: ${json.error}`);
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
}

// Open a streaming completion, retrying once on a transient connection error
// (e.g. the first request that triggers a slow cold model load).
async function createStream(params: any, signal?: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
  const cfg = getConfig();
  const provider = await checkProvider();

  const open = async (): Promise<AsyncIterable<ChatCompletionChunk>> => {
    if (provider === "ollama") {
      return ollamaStream(params, signal);
    } else {
      // Every non-Ollama backend (vLLM, LM Studio, llama.cpp, commercial OpenAI)
      // speaks the OpenAI /v1 API. Messages may carry Ollama-style `images`
      // (base64) — convert them to the OpenAI content-parts format.
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
      // Ask vLLM (and the commercial OpenAI API) to include token usage in the
      // stream so the UI shows real counts. Skip it for unknown LOCAL servers
      // (llama.cpp / LM Studio) that may reject the extra field with a 400.
      const extra: any = {};
      if (provider === "vllm" || !isLocalUrl(cfg.baseUrl)) extra.stream_options = { include_usage: true };
      const client = getClient();
      return client.chat.completions.create({ ...params, ...extra, messages }, { signal }) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>;
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
    if (await checkProvider() === "ollama") {
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

export type ToolCallPhase = "arguments" | "queued" | "running" | "completed" | "denied" | "blocked" | "failed";

export interface ToolCallMeta {
  /** Stable for the lifetime of this call and suitable for UI correlation. */
  callId: string;
  /** Position in the model's tool-call batch. */
  index: number;
  phase: ToolCallPhase;
  /** When the model first began emitting this call, when available. */
  detectedAt?: number;
  /** Wall-clock execution start. */
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export type ToolPermissionDecision = boolean | {
  /** Optional user-edited arguments (for example selected diff hunks). */
  args?: any;
  /** Consumers should echo this to protect against stale approval responses. */
  callId?: string;
};

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onToolCall: (name: string, args: string, meta?: ToolCallMeta) => void;
  onToolCallProgress?: (name: string, args: string, meta?: ToolCallMeta) => void;
  onToolResult: (name: string, result: string, meta?: ToolCallMeta) => void;
  onError: (err: Error) => void;
  // One-off informational notices (e.g. falling back to prompted tool-calling).
  onNotice?: (msg: string) => void;
  // Periodic "still working" pulse while waiting for the model's first token.
  // Unlike onNotice, this is EPHEMERAL — the UI should refresh a single live
  // line with it, never append a new transcript entry per tick (a long prefill
  // on a big context would otherwise stack up dozens of identical paragraphs).
  // Falls back to onNotice when a consumer doesn't implement it.
  onHeartbeat?: (msg: string, info: { phase: "loading" | "prefill"; elapsedSec: number }) => void;
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
  requestPermission?: (name: string, args: any, meta?: ToolCallMeta) => Promise<ToolPermissionDecision>;
  // Ask the user to pick from options (the ask_user tool). Returns their answer.
  requestChoice?: (question: string, options: string[]) => Promise<string>;
  // Present a finished plan for approval (the propose_plan tool). "approve"
  // turns plan mode OFF for the rest of this chat() run so the model can
  // implement immediately; "keep" continues planning; "reject" stops the plan.
  requestPlanApproval?: (plan: string) => Promise<"approve" | "keep" | "reject">;
  // A repeated tool call was detected. Advisory: the turn keeps running unless
  // willStop is true — the UI should surface it with a manual Stop, since this
  // fires on legitimate work often enough that auto-killing the turn is wrong.
  onLoopWarning?: (info: { tool: string; trips: number; willStop: boolean }) => void;
}

export interface ChatOptions {
  signal?: AbortSignal;
  planMode?: boolean;   // block mutating tools (research only)
  chatMode?: boolean;   // block mutating tools (conversation only — answer in text)
  autoAccept?: boolean; // skip permission prompts
}

// Cache tool-support detection and 400-fallbacks per baseUrl::model.
const toolSupportCache = new Map<string, boolean>();
const forcedPrompted = new Set<string>();
const noticed = new Set<string>();
// Count Ollama tool-parse failures per baseUrl::model so we retry once before
// permanently falling back to prompted tool-calling (see isOllamaToolParseError).
const toolParseFailures = new Map<string, number>();

function key(): string {
  const cfg = getConfig();
  return `${cfg.baseUrl}::${cfg.model}`;
}

function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local")
    ) {
      return true;
    }
    if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return true;
    if (hostname.startsWith("172.")) {
      const parts = hostname.split(".");
      const second = Number(parts[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return true; // fallback
  }
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
  let useNative: boolean;
  if (supported !== null) {
    useNative = supported;
  } else {
    // Native-tool support couldn't be probed (non-Ollama backend). Decide by
    // provider:
    //  - Ollama (old build, no capabilities array) and vLLM both speak native
    //    tool-calling; default native. If a vLLM server was launched WITHOUT a
    //    tool-call parser, the mid-flight "fallback" path switches to prompted.
    //  - A commercial OpenAI-compatible API (non-local) → native.
    //  - An unknown LOCAL OpenAI server (LM Studio / llama.cpp / KoboldCPP) often
    //    mishandles tool messages → default to prompted, which is safe anywhere.
    const provider = await checkProvider();
    useNative = provider === "ollama" || provider === "vllm" || !isLocalUrl(cfg.baseUrl);
  }
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

async function reportTurnStart(callbacks: StreamCallbacks): Promise<"loading" | "prefill"> {
  const cfg = getConfig();
  let phase: "loading" | "prefill" = "prefill";
  try {
    if (await checkOllama(cfg.baseUrl)) {
      const loaded = await loadedModels(cfg.baseUrl);
      const base = cfg.model.split(":")[0]!;
      const m = loaded.find(x => x.name === cfg.model) ?? loaded.find(x => x.name.startsWith(base));
      if (!m) { phase = "loading"; callbacks.onStatus?.("loading"); return phase; }
      if (m.size && m.sizeVram !== undefined && m.sizeVram < m.size && !vramNoticed.has(cfg.model)) {
        vramNoticed.add(cfg.model);
        const pct = Math.round((m.sizeVram / m.size) * 100);
        const gb = (n: number) => (n / 1e9).toFixed(1);
        callbacks.onNotice?.(
          `"${cfg.model}" doesn't fully fit in VRAM — only ${pct}% is on the GPU (${gb(m.sizeVram)} of ${gb(m.size)} GB); the rest runs from system RAM, which slows generation a lot. ` +
          `The KV cache grows with num_ctx, so to fit a LARGE context, quantize it: start Ollama with OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 (q4_0 for even more), or use vLLM. Otherwise use a smaller weight quant (e.g. q4_K_M), lower the context window (/config contextWindow <n>), or a smaller model.`
        );
      }
    }
  } catch { /* status is best-effort */ }
  callbacks.onStatus?.("prefill");
  return phase;
}

function finishToolCall(
  name: string,
  result: string,
  callbacks: StreamCallbacks,
  meta: ToolCallMeta,
  phase: Exclude<ToolCallPhase, "arguments" | "queued" | "running">
): string {
  const completedAt = Date.now();
  callbacks.onToolResult(name, result, {
    ...meta,
    phase,
    completedAt,
    durationMs: meta.startedAt === undefined ? undefined : Math.max(0, completedAt - meta.startedAt),
  });
  return result;
}

// Shared policy gate: plan-mode block, permission, execution. Returns result.
async function runTool(
  name: string,
  args: any,
  callbacks: StreamCallbacks,
  options: ChatOptions,
  meta: ToolCallMeta
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
    return finishToolCall(name, r, callbacks, meta, "completed");
  }

  // propose_plan is the plan-mode exit: the plan goes to an interactive
  // approve / keep-planning prompt. Approval flips planMode OFF for the rest of
  // this run so the model can implement immediately, Claude Code-style.
  if (name === "propose_plan") {
    const plan = String(args?.plan ?? "").trim();
    let r: string;
    if (!plan) {
      r = "Error: propose_plan needs the COMPLETE plan in 'plan' (markdown: numbered steps, files to change, verification). Call it again with the full plan.";
    } else if (callbacks.requestPlanApproval) {
      let decision: "approve" | "keep" | "reject" = "keep";
      try { decision = await callbacks.requestPlanApproval(plan); } catch { /* treat as keep */ }
      if (decision === "approve") {
        const wasPlanning = options.planMode === true;
        options.planMode = false;
        r = wasPlanning
          ? "The user APPROVED the plan. Plan mode is now OFF — write/edit/bash tools are unblocked. Implement the plan NOW, step by step, in this same run. Use set_todos to track the steps as you go."
          : "The user APPROVED the plan. Implement it NOW, step by step, in this same run. Use set_todos to track the steps as you go.";
      } else if (decision === "reject") {
        r = "The user REJECTED the plan. Do not implement it. Stop here and wait for further instructions from the user.";
      } else {
        r = "The user wants to KEEP PLANNING — the plan is not approved yet. Refine it based on the conversation so far (or ask ONE focused question about what to change), then propose it again. Do not modify any files.";
      }
    } else {
      r = "Plan noted. There is no interactive approval available in this context — present the plan as your final answer and wait for the user's reply.";
    }
    return finishToolCall(name, r, callbacks, meta, r.startsWith("Error:") ? "failed" : "completed");
  }

  const needsPermission = requiresToolPermission(name);

  if (options.planMode && needsPermission) {
    const r = `[plan mode] ${name} is blocked. You are planning, not executing — present your plan and wait for approval.`;
    return finishToolCall(name, r, callbacks, meta, "blocked");
  }
  // Chat mode is enforced here, not just in the prompt: models reliably ignore a
  // "don't build" instruction the moment a request sounds like work.
  if (options.chatMode && needsPermission) {
    const r = `[chat mode] ${name} is blocked — the user asked to talk, not to have files built. Write the answer directly in your reply instead (a list means a list in the message; show code as a fenced block, don't create the file). If this genuinely requires changing files, say so in one line and ask the user to switch to normal or auto mode. Do not call this tool again.`;
    return finishToolCall(name, r, callbacks, meta, "blocked");
  }

  if (needsPermission && !options.autoAccept) {
    // Skip the prompt for tools the user permanently allowed (Always allow / 'a').
    const persisted = getConfig().alwaysAllow ?? [];
    if (!persisted.includes(name)) {
      // Permission is fail-closed. A headless consumer must opt into autoAccept;
      // merely omitting the callback can never grant a side-effecting call.
      if (!callbacks.requestPermission) {
        return finishToolCall(name, "Tool call denied: no permission handler is available.", callbacks, meta, "denied");
      }

      let decision: ToolPermissionDecision;
      try {
        decision = await callbacks.requestPermission(name, args, meta);
      } catch {
        return finishToolCall(name, "Tool call denied: the permission request failed or was cancelled.", callbacks, meta, "denied");
      }

      if (decision !== true && (!decision || typeof decision !== "object")) {
        return finishToolCall(name, "Tool call denied by user.", callbacks, meta, "denied");
      }

      if (typeof decision === "object") {
        if (decision.callId === undefined && !Object.prototype.hasOwnProperty.call(decision, "args")) {
          return finishToolCall(name, "Tool call denied: the permission response was incomplete.", callbacks, meta, "denied");
        }
        // Newer consumers echo the call ID. Reject a response for an old prompt
        // instead of applying it to whichever tool happens to be pending now.
        if (decision.callId !== undefined && decision.callId !== meta.callId) {
          return finishToolCall(name, "Tool call denied: stale or mismatched approval response.", callbacks, meta, "denied");
        }
        // Partial approval: the user selected a subset of the diff's hunks.
        if (Object.prototype.hasOwnProperty.call(decision, "args")) {
          if (!decision.args || typeof decision.args !== "object" || Array.isArray(decision.args)) {
            return finishToolCall(name, "Tool call denied: the approved arguments were invalid.", callbacks, meta, "denied");
          }
          args = decision.args;
        }
      }
    }
  }
  let result: string;
  try {
    // onNotice lets a slow tool narrate while it works — image generation uses
    // it to report VRAM swapping, which otherwise looks like a 60-second hang.
    result = await executeTool(name, args, callbacks.onNotice);
  } catch (e: any) {
    result = `Error: ${e.message}`;
  }
  return finishToolCall(name, result, callbacks, meta, result.startsWith("Error:") ? "failed" : "completed");
}

export interface NormCall { id?: string; callId?: string; name: string; args: any; rawArgs: string; detectedAt?: number; }

let localToolCallSequence = 0;
function nextLocalToolCallId(): string {
  localToolCallSequence = (localToolCallSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `call_local_${Date.now().toString(36)}_${localToolCallSequence.toString(36)}`;
}

// Execute a turn's tool calls. Read-only calls run concurrently (so the agent
// can read/search many files at once); mutating calls run sequentially so
// permission prompts + diffs are shown one at a time. Callbacks fire per call in
// the original order, and results are returned in that order.
async function executeCalls(
  calls: NormCall[],
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<{ id?: string; name: string; result: string }[]> {
  // Surface every call, in model order, before any execution begins. This keeps
  // slow reads from looking like the model is still thinking and gives clients
  // stable IDs with which to correlate permissions and results.
  const metas = calls.map((c, index): ToolCallMeta => {
    if (!c.callId) c.callId = c.id || nextLocalToolCallId();
    if (!c.id) c.id = c.callId;
    const meta: ToolCallMeta = {
      callId: c.callId,
      index,
      phase: "queued",
      detectedAt: c.detectedAt,
    };
    callbacks.onToolCall(c.name, c.rawArgs, meta);
    return meta;
  });

  const markRunning = (c: NormCall, index: number): ToolCallMeta => {
    const meta: ToolCallMeta = { ...metas[index]!, phase: "running", startedAt: Date.now() };
    metas[index] = meta;
    callbacks.onToolCallProgress?.(c.name, c.rawArgs, meta);
    return meta;
  };

  // Kick off explicitly parallel-safe calls concurrently.
  const preRun = new Map<number, string>();
  await Promise.all(calls.map(async (c, i) => {
    if (!isParallelSafeTool(c.name)) return;
    markRunning(c, i);
    try { preRun.set(i, await executeTool(c.name, c.args)); }
    catch (e: any) { preRun.set(i, `Error: ${e.message}`); }
  }));

  const out: { id?: string; name: string; result: string }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const meta = metas[i]!;
    let result: string;
    if (preRun.has(i)) {
      result = preRun.get(i)!;
      finishToolCall(c.name, result, callbacks, meta, result.startsWith("Error:") ? "failed" : "completed");
    } else {
      result = await runTool(c.name, c.args, callbacks, options, markRunning(c, i));
    }
    // Feed build/test outcomes to the orchestrator's failure tracker so the
    // two-strike Chrome override can arm/disarm across turns.
    noteToolOutcome(c.name, c.args, result);
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

// Repeat detection is ADVISORY by default. A false positive that kills a turn
// mid-way through real work (writing a long file, re-running a test whose output
// hasn't changed yet) is far more damaging than a genuine loop running a few
// extra iterations — maxIterations is the real backstop, and the user has a Stop
// button. So: nudge the model first, and only abort if the user opted into
// loopAction:"stop" and it keeps happening.
type LoopVerdict = "ok" | "warn" | "stop";

function checkToolLoop(
  norm: NormCall[],
  results: { name: string; result: string }[],
  toolLoopGuard: ToolLoopGuard | undefined,
  callbacks: StreamCallbacks,
  history: ChatCompletionMessageParam[]
): LoopVerdict {
  if (!toolLoopGuard) return "ok";
  let detected = false;
  for (let i = 0; i < norm.length; i++) {
    const call = norm[i];
    if (call && toolLoopGuard.record(call.name, call.args, results[i]?.result ?? "")) {
      detected = true;
    }
  }
  if (!detected) return "ok";

  const tool = toolLoopGuard.lastSignature;
  const trips = toolLoopGuard.trips;
  const hardStop = getConfig().loopAction === "stop" && trips >= 2;

  // Tell the model what we saw so it can correct itself — this is what actually
  // breaks a real loop, and it costs a genuine worker nothing.
  history.push({
    role: "user",
    content: `<system_note>You have now called ${tool} several times in a row with identical arguments AND received an identical result each time. Repeating it will not produce anything new. Either take a different approach (different arguments, a different tool, or read the previous result more carefully), or stop and give your final answer. Do not repeat that exact call again.</system_note>`,
  });

  // Surfaced separately from onNotice so the UI can show a dismissible warning
  // with a Stop button instead of a passive log line.
  callbacks.onLoopWarning?.({ tool, trips, willStop: hardStop });

  if (hardStop) {
    callbacks.onNotice?.(`Stopped: ${tool} repeated with identical results ${trips} times. (This is the strict setting — set loopAction to "warn" in /config if it's stopping legitimate work.)`);
    return "stop";
  }
  callbacks.onNotice?.(`Heads up: ${tool} has repeated with identical results. I've told the model to change approach — it's still running. Press Stop if it's genuinely stuck.`);
  return "warn";
}

export async function chat(
  messages: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions = {}
): Promise<ChatCompletionMessageParam[]> {
  const history = [...messages];

  // Update orchestrator state from the newest GENUINE user message (the caller
  // pushes the user's input as the last message before invoking chat(); internal
  // nudges/tool-responses are only appended to `history` later, inside the loop).
  // `error_streak` / `is_from_scratch` drive the <RUNTIME_OVERRIDE> injection.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user" && typeof lastMsg.content === "string") {
    const isFirstUserTurn = messages.filter(m => m.role === "user").length === 1;
    noteUserTurn(lastMsg.content, isFirstUserTurn);
  }

  let useNative = await resolveUseNative(callbacks);
  const maxIterations = getConfig().maxIterations || 50;
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
    // Green-field manifest gate: ending the turn with a manifest and no tool call
    // is the REQUIRED behaviour, so don't nudge it as if it were a stall.
    if (isAwaitingScaffold()) return "break";
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
    callbacks.onNotice?.("The model returned an empty response several times in a row even after retrying and nudging. This is usually a one-off hiccup on this turn — resend your message. If it keeps happening with this model, turning reasoning off can help (/think off).");
    return "break";
  };

  while (iteration++ < maxIterations) {
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

    const extra = Math.ceil((buildRuntimeOverride().length + (useNative ? "" : promptedToolInstructions()).length) / 4) + (useNative ? TOOLS_TOKEN_EST : 0);
    if (!(await fitContext(history, extra, callbacks.onNotice))) {
      callbacks.onError?.(new Error("The project instructions or latest input exceed the available context budget. Use smaller attachments or a larger context window."));
      break;
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
      // Re-run the same turn without consuming an iteration (used for the
      // one-shot retry after an Ollama tool-parse hiccup).
      if (outcome === "retry") { iteration--; continue; }
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

  if (iteration > maxIterations) {
    callbacks.onNotice?.(`Reached the safety limit of ${maxIterations} iterations. If the task is not finished, you can type "continue" or "keep going" to proceed.`);
  }

  return history;
}

// ─── Native tool-calling turn ─────────────────────────────────────────────────
type NativeOutcome = "done" | "continue" | "fallback" | "loop_detected" | "empty" | "retry";

async function nativeTurn(
  history: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions,
  toolLoopGuard?: ToolLoopGuard
): Promise<NativeOutcome> {
  const cfg = getConfig();
  let assistantText = "";
  let genChars = 0;
  const toolCallsByIndex = new Map<number, { id: string; callId: string; name: string; args: string; detectedAt: number }>();
  const providerToInternalIndex = new Map<number, number>();
  // Hide tool calls the model PRINTS as ```json blocks (qwen-coder does this) from
  // the live display, while keeping the full text for parsing/the fallback.
  const narr = new NarrationFilter();
  const harmony = new HarmonyFilter();     // route <|channel|>… (gemma/gpt-oss): analysis→think, drop tool narration
  const rep = new RepetitionGuard();       // stop degenerate repeat loops (opt-in)
  const guardOn = cfg.loopGuard === true;
  let looped = false;
  let firstToken = true;
  let genStart = 0;

  const wdAc = linkAbort(options.signal);
  const wd = new StreamWatchdog(callbacks, () => wdAc.abort(), cfg.stallHeartbeatSec, cfg.stallTimeoutSec, "the model's response");

  try {
    wd.setPhase(await reportTurnStart(callbacks));
    // Dynamic per-turn system-prompt override (two-strike Chrome force /
    // green-field manifest gate). Empty string when no rule applies — a no-op.
    // Appended request-only; the stored `history` keeps its clean system prompt.
    const override = buildRuntimeOverride();
    const reqMessages = override ? augmentSystem(history, override) : history;
    const stream = await createStream(
      {
        model: cfg.model,
        messages: reqMessages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        max_tokens: outputBudget(reqMessages, TOOLS_TOKEN_EST),
        temperature: cfg.temperature,
        stream: true,
      },
      wdAc.signal
    );

    for await (const chunk of stream) {
      if (wdAc.signal.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.(toUsage(u, genStart));
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (firstToken && (delta.content || delta.tool_calls)) { firstToken = false; genStart = Date.now(); wd.disarm(); callbacks.onStatus?.("generating"); }
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
            const initialId = tc.id || nextLocalToolCallId();
            entry = { id: initialId, callId: initialId, name: "", args: "", detectedAt: Date.now() };
            toolCallsByIndex.set(internalIdx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments;
            genChars += tc.function.arguments.length;
          }
          if (entry.name) {
            callbacks.onToolCallProgress?.(entry.name, entry.args, {
              callId: entry.callId,
              index: internalIdx,
              phase: "arguments",
              detectedAt: entry.detectedAt,
            });
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
    // The backend's server-side tool-call parser choked on malformed/truncated
    // JSON from the model (not missing tool support). Retry once — it's often a
    // sampling fluke — then fall back to prompted tool-calling, which avoids the
    // parser entirely and passes bodies raw.
    if (isOllamaToolParseError(msg)) {
      const k = key();
      const n = (toolParseFailures.get(k) ?? 0) + 1;
      toolParseFailures.set(k, n);
      if (n <= 1) {
        callbacks.onNotice?.("The backend returned an invalid/truncated tool call (the model's tool-call JSON was malformed). Retrying…");
        return "retry";
      }
      callbacks.onNotice?.("The native tool-call parser keeps rejecting this model's tool calls (truncated argument JSON) — switching to prompted tool-calling, which passes bodies raw and avoids the parser.");
      return "fallback";
    }
    // The watchdog aborted a stalled turn (no token within the cap) — retryable,
    // not a user stop. chat()'s handleEmpty retries (and nudges if it persists).
    if (wd.firedAbort && !options.signal?.aborted) return "empty";
    if (err?.name === "AbortError") {
      if (options.signal?.aborted) return "done";
      return "empty";
    }
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
    callbacks.onNotice?.("The model reasoned for the entire turn but never produced an answer — it most likely ran out of output tokens mid-thought. Raise the limit (/config maxTokens <n>), or turn reasoning off (/think off).");
    return "done";
  }

  // gpt-oss/harmony sometimes leaks a tool call's ARGUMENTS as bare JSON in the
  // content channel (the function name lived in the dropped channel header), so
  // the call dead-ends as a JSON "final answer". Recover it as a real tool call,
  // stored as a proper native call (not raw JSON content) so history stays clean
  // and the work actually happens. parseLeakedToolCall only fires on an
  // unambiguous, name-less arg object (see its doc), so this is safe.
  if (toolCalls.length === 0) {
    const leaked = parseLeakedToolCall(storedText);
    if (leaked.length > 0) {
      const norm: NormCall[] = leaked.map((c, i) => ({
        id: `call_${Date.now()}_${i}`,
        name: canonicalToolName(c.name),
        args: c.arguments,
        rawArgs: JSON.stringify(c.arguments),
      }));
      history.push({
        role: "assistant",
        content: null,
        tool_calls: norm.map(c => ({ id: c.id!, type: "function" as const, function: { name: c.name, arguments: c.rawArgs } })),
      });
      callbacks.onNotice?.(`Recovered a ${norm.map(c => c.name).join(", ")} call the model emitted as plain JSON (a gpt-oss/harmony quirk) and ran it.`);
      const results = await executeCalls(norm, callbacks, options);
      for (const r of results) history.push({ role: "tool", tool_call_id: r.id!, content: r.result });
      if (checkToolLoop(norm, results, toolLoopGuard, callbacks, history) === "stop") {
        return "loop_detected";
      }
      return "continue";
    }
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
      if (checkToolLoop(norm, results, toolLoopGuard, callbacks, history) === "stop") {
        return "loop_detected";
      }
      return "continue";
    }
    return "done";
  }

  const norm: NormCall[] = toolCalls.map(tc => {
    let args: any = {};
    try { args = JSON.parse(tc.args || "{}"); } catch {}
    return { id: tc.id, callId: tc.callId, name: canonicalToolName(tc.name), args, rawArgs: tc.args, detectedAt: tc.detectedAt };
  });
  const results = await executeCalls(norm, callbacks, options);
  for (const r of results) history.push({ role: "tool", tool_call_id: r.id!, content: r.result });
  if (checkToolLoop(norm, results, toolLoopGuard, callbacks, history) === "stop") {
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
  // plus any dynamic <RUNTIME_OVERRIDE> for this turn (two-strike Chrome force /
  // green-field manifest gate). Request-only — the stored history keeps the clean
  // system prompt.
  const request = augmentSystem(history, promptedToolInstructions() + buildRuntimeOverride());

  let raw = "";
  const prose = new ProseFilter();
  const rep = new RepetitionGuard();
  const guardOn = cfg.loopGuard === true;
  let looped = false;
  let firstToken = true;
  let genStart = 0;

  const wdAc = linkAbort(options.signal);
  const wd = new StreamWatchdog(callbacks, () => wdAc.abort(), cfg.stallHeartbeatSec, cfg.stallTimeoutSec, "the model's response");

  try {
    wd.setPhase(await reportTurnStart(callbacks));
    const stream = await createStream(
      {
        model: cfg.model,
        messages: request,
        max_tokens: outputBudget(request),
        temperature: cfg.temperature,
        stream: true,
      },
      wdAc.signal
    );

    for await (const chunk of stream) {
      if (wdAc.signal.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.(toUsage(u, genStart));
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content;
      if (!text) continue;
      if (firstToken) { firstToken = false; genStart = Date.now(); wd.disarm(); callbacks.onStatus?.("generating"); }
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
    if (err?.name === "AbortError") {
      if (options.signal?.aborted) return "done";
      return "empty";
    }
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
    callbacks.onNotice?.("The model reasoned for the entire turn but never produced an answer — it most likely ran out of output tokens mid-thought. Raise the limit (/config maxTokens <n>), or turn reasoning off (/think off).");
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
  if (checkToolLoop(norm, results, toolLoopGuard, callbacks, history) === "stop") {
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

export async function fitContext(history: ChatCompletionMessageParam[], extraTokens = 0, notice?: (message: string) => void): Promise<boolean> {
  const cfg = getConfig();
  const reserve = Math.min(cfg.maxTokens, Math.max(1024, Math.floor(cfg.contextWindow * 0.15)));
  const fits = () => Math.ceil((estimateTokens(history) + extraTokens) * 1.15) + reserve + 512 <= cfg.contextWindow;
  if (fits()) return true;
  if (!cfg.autoCompact) return false;
  // Preserve message roles and tool-call pairing while retiring verbose evidence.
  let pruned = false;
  for (const m of history) {
    if (typeof m.content !== "string" || m.content.length <= 1200) continue;
    if (m.role === "tool" || (m.role === "user" && m.content.startsWith("<tool_response"))) {
      m.content = m.content.slice(0, 1000) + "\n[Earlier tool output shortened to fit context. Read targeted excerpts again if needed.]";
      pruned = true;
      if (fits()) break;
    }
  }
  if (pruned) notice?.("Shortened earlier tool output to preserve context space.");
  if (fits()) return true;
  // Only summarize earlier turns. Never discard the current user request and
  // its tool-call sequence simply because it is large.
  let latest = -1;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("<tool_response") && !m.content.startsWith("[automatic notice")) latest = i;
  }
  if (latest > 1) {
    const summary = await summarizeConversation(history.slice(0, latest));
    const systems = history.slice(0, latest).filter(m => m.role === "system");
    history.splice(0, latest, ...systems, { role: "user", content: `[Earlier conversation summary]\n${summary}` });
    notice?.("Compacted earlier conversation before the next model request.");
  }
  return fits();
}

export async function summarizeConversation(messages: ChatCompletionMessageParam[]): Promise<string> {
  const cfg = getConfig();
  const client = getClient();
  let transcript = messages
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

  const transcriptLimit = Math.max(256, Math.floor((cfg.contextWindow - 2048) * 2));
  if (transcript.length > transcriptLimit) {
    const half = Math.floor(transcriptLimit / 2);
    transcript = transcript.slice(0, half) + "\n[Middle of transcript omitted to fit summarization budget.]\n" + transcript.slice(-half);
  }

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
