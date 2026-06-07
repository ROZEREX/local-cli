import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionChunk } from "openai/resources/chat/completions";
import { getConfig } from "./config";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { executeTool, canonicalToolName } from "./tools/executor";
import { detectToolSupport, isOllama, modelCapabilities } from "./ollama";
import { parseToolCalls, ProseFilter } from "./toolparse";
import { promptedToolInstructions } from "./prompt";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  const cfg = getConfig();
  if (!_client || (_client as any)._baseURL !== cfg.baseUrl) {
    _client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  }
  return _client;
}

export function resetClient() {
  _client = null;
}

// Connection errors worth one retry (cold model load can drop the socket).
function isTransient(err: any): boolean {
  if (err?.name === "AbortError") return false;
  const m = String(err?.message ?? err).toLowerCase();
  return ["socket", "econnreset", "connection", "terminated", "fetch failed", "network", "timeout"].some(s => m.includes(s));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Reasoning is shown live but must NOT be stored in history (it bloats context
// and confuses the model on the next turn).
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
}

let _isOllamaCache: boolean | null = null;
async function checkOllama(baseUrl: string): Promise<boolean> {
  if (_isOllamaCache !== null) return _isOllamaCache;
  _isOllamaCache = await isOllama(baseUrl);
  return _isOllamaCache;
}

async function* ollamaStream(params: any, signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  
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
              // fallback
            }
          }
          return tc;
        }),
      };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        content: `[Tool result for call ${m.tool_call_id}]:\n${m.content}`,
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
          (chunk as any).usage = {
            prompt_tokens: json.prompt_eval_count ?? 0,
            completion_tokens: json.eval_count ?? 0,
            tok_per_sec: json.eval_count && json.eval_duration ? json.eval_count / (json.eval_duration / 1e9) : 0,
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
      const client = getClient();
      return client.chat.completions.create(params, { signal }) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>;
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
export async function warmUp(): Promise<void> {
  try {
    const cfg = getConfig();
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
  // Return false to deny a tool call. Mutating tools route through here.
  requestPermission?: (name: string, args: any) => Promise<boolean>;
}

export interface ChatOptions {
  signal?: AbortSignal;
  planMode?: boolean;   // block mutating tools (research only)
  autoAccept?: boolean; // skip permission prompts
}

// Tools that change disk / run arbitrary code.
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "bash", "run_server", "stop_server", "update_profile"]);
// Read-only tools — safe to run in parallel (e.g. reading many files at once).
const READONLY_TOOLS = new Set(["read_file", "glob_files", "grep_files", "list_dir", "server_logs", "list_servers", "read_profile"]);
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

// Shared policy gate: plan-mode block, permission, execution. Returns result.
async function runTool(
  name: string,
  args: any,
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<string> {
  if (options.planMode && MUTATING_TOOLS.has(name)) {
    const r = `[plan mode] ${name} is blocked. You are planning, not executing — present your plan and wait for approval.`;
    callbacks.onToolResult(name, r);
    return r;
  }
  if (MUTATING_TOOLS.has(name) && !options.autoAccept && callbacks.requestPermission) {
    const approved = await callbacks.requestPermission(name, args);
    if (!approved) {
      const r = "Tool call denied by user.";
      callbacks.onToolResult(name, r);
      return r;
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

export async function chat(
  messages: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions = {}
): Promise<ChatCompletionMessageParam[]> {
  const history = [...messages];
  let useNative = await resolveUseNative(callbacks);
  let iteration = 0;

  while (iteration++ < MAX_ITERATIONS) {
    if (options.signal?.aborted) break;

    if (useNative) {
      const outcome = await nativeTurn(history, callbacks, options);
      if (outcome === "fallback") {
        // Server rejected tools mid-flight — switch to prompted and retry turn.
        forcedPrompted.add(key());
        toolSupportCache.set(key(), false);
        notifyPrompted(callbacks);
        useNative = false;
        iteration--;
        continue;
      }
      if (outcome === "done") break;
      // otherwise "continue" (tools ran) → loop
    } else {
      const more = await promptedTurn(history, callbacks, options);
      if (!more) break;
    }
  }

  return history;
}

// ─── Native tool-calling turn ─────────────────────────────────────────────────
type NativeOutcome = "done" | "continue" | "fallback";

async function nativeTurn(
  history: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<NativeOutcome> {
  const cfg = getConfig();
  let assistantText = "";
  let genChars = 0;
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();

  try {
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
      options.signal
    );

    for await (const chunk of stream) {
      if (options.signal?.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, tokPerSec: u.tok_per_sec });
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) { assistantText += delta.content; genChars += delta.content.length; callbacks.onText(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = toolCallsByIndex.get(idx);
          if (!entry) { entry = { id: tc.id || `call_${Date.now()}_${idx}`, name: "", args: "" }; toolCallsByIndex.set(idx, entry); }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) { entry.args += tc.function.arguments; genChars += tc.function.arguments.length; }
        }
      }
      callbacks.onProgress?.(Math.round(genChars / 4));
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/does not support tools/i.test(msg) || /tools.*not supported/i.test(msg)) return "fallback";
    if (err?.name === "AbortError") return "done";
    callbacks.onError(err);
    return "done";
  }

  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort((a, b) => a[0] - b[0]).map(([, v]) => v).filter(tc => tc.name);

  if (!assistantText && toolCalls.length === 0) {
    callbacks.onNotice?.("The model returned an empty response. This can happen if the model's context window is exceeded, it is still loading, or the service is overloaded. Try running /compact to shrink the conversation history, or switch to a model with a larger context window.");
    return "done";
  }

  const storedText = stripThink(assistantText);
  if (storedText || toolCalls.length > 0) {
    history.push({
      role: "assistant",
      content: storedText || null,
      ...(toolCalls.length > 0 ? {
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
      } : {}),
    });
  }

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
  return "continue";
}

// ─── Prompted tool-calling turn (no native function support) ──────────────────
async function promptedTurn(
  history: ChatCompletionMessageParam[],
  callbacks: StreamCallbacks,
  options: ChatOptions
): Promise<boolean> {
  const cfg = getConfig();

  // Build request messages: augment the system message with tool instructions
  // (request-only — the stored history keeps the clean system prompt).
  const request = augmentSystem(history, promptedToolInstructions());

  let raw = "";
  const prose = new ProseFilter();

  try {
    const stream = await createStream(
      {
        model: cfg.model,
        messages: request,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: true,
      },
      options.signal
    );

    for await (const chunk of stream) {
      if (options.signal?.aborted) break;
      const u = (chunk as any).usage;
      if (u) callbacks.onUsage?.({ inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, tokPerSec: u.tok_per_sec });
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content;
      if (!text) continue;
      raw += text;
      callbacks.onProgress?.(Math.round(raw.length / 4));
      // Show prose but hide raw tool-call markup; <think> is handled upstream.
      const visible = prose.push(text);
      if (visible) callbacks.onText(visible);
    }
    const tail = prose.flush();
    if (tail) callbacks.onText(tail);
  } catch (err: any) {
    if (err?.name === "AbortError") return false;
    callbacks.onError(err);
    return false;
  }

  if (!raw.trim()) {
    callbacks.onNotice?.("The model returned an empty response. This can happen if the model's context window is exceeded, it is still loading, or the service is overloaded. Try running /compact to shrink the conversation history, or switch to a model with a larger context window.");
    return false;
  }

  // Strip reasoning before parsing/storing (shown live, not kept in history).
  const cleanRaw = stripThink(raw);
  history.push({ role: "assistant", content: cleanRaw });

  const calls = parseToolCalls(cleanRaw);
  if (calls.length === 0) return false; // final answer

  const norm: NormCall[] = calls.map(call => ({ name: canonicalToolName(call.name), args: call.arguments, rawArgs: JSON.stringify(call.arguments) }));
  const results = await executeCalls(norm, callbacks, options);
  const responses = results.map(r => `<tool_response name="${r.name}">\n${r.result}\n</tool_response>`);
  history.push({
    role: "user",
    content: `${responses.join("\n")}\n\nPlease analyze the tool output. Output the next tool call, or if you are done, provide a final response summarizing the changes or results for the user.`,
  });
  return true;
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
export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  return Math.round(JSON.stringify(messages).length / 4);
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
