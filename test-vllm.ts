// vLLM backend support. vLLM speaks the OpenAI /v1 API and supports native
// tool-calling, but it was previously misdetected as a generic local server and
// defaulted to (unreliable) prompted tool-calling, and /models + the picker only
// knew how to talk to Ollama. This test pins the new behavior: provider
// detection, /v1/models listing, and an end-to-end native-tools chat that routes
// through the OpenAI path (NOT ollamaStream).
import "./test-config-setup";
import { isVllm, detectProvider, listOpenAIModels, listModelsForPicker } from "./src/ollama";
import { parseToolCalls } from "./src/toolparse";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// A minimal vLLM-like server: root /version, OpenAI /v1/models, and an SSE
// /v1/chat/completions that emits a native tool call then a final answer. It
// 404s /api/version so it is NOT mistaken for Ollama.
const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: null }] };
let chatTurns = 0;
let lastBody: any = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/version") return new Response("not ollama", { status: 404 });
    if (p === "/version") return Response.json({ version: "0.6.3" });
    if (p === "/v1/models")
      return Response.json({ object: "list", data: [{ id: "qwen", object: "model", max_model_len: 8192 }, { id: "llama", object: "model", max_model_len: 4096 }] });
    if (p === "/v1/chat/completions") {
      lastBody = await req.json().catch(() => null);
      chatTurns++;
      const chunks =
        chatTurns === 1
          ? [
              { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "glob_files", arguments: "" } }] }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":"**/*.ts"}' } }] }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
              { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
            ]
          : [
              { ...base, choices: [{ index: 0, delta: { content: "Listed the files — done." }, finish_reason: null }] },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              { ...base, choices: [], usage: { prompt_tokens: 30, completion_tokens: 6 } },
            ];
      const body = chunks.map(sse).join("") + "data: [DONE]\n\n";
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("nf", { status: 404 });
  },
});
const baseUrl = `http://localhost:${server.port}/v1`;

// ── detection + model listing ──
check("isVllm true for a /version server", await isVllm(baseUrl));
check("detectProvider → vllm (auto)", (await detectProvider(baseUrl, "auto")) === "vllm");
check("forced provider wins over auto-detect", (await detectProvider(baseUrl, "ollama")) === "ollama");
const models = await listOpenAIModels(baseUrl);
check("listOpenAIModels reads /v1/models", models.length === 2 && models.some(m => m.name === "qwen"), JSON.stringify(models));
check("surfaces vLLM max_model_len as context", models.find(m => m.name === "qwen")?.contextLength === 8192);
const picked = await listModelsForPicker(baseUrl, "auto");
check("listModelsForPicker routes vLLM → /v1/models", picked.length === 2);

// ── tool-call text recovery: some Qwen AWQ builds on vLLM emit the call as
//    content wrapped in <tools>…</tools> with an EMPTY native tool_calls field.
//    parseToolCalls must recover it (this is the exact string vLLM returned). ──
const toolsWrapped = '<tools>\n{"name": "list_files", "arguments": {"path": "/etc"}}\n</tools>';
const recoveredTools = parseToolCalls(toolsWrapped);
check("<tools> wrapper recovered as a tool call", recoveredTools.length === 1 && recoveredTools[0]!.name === "list_files" && recoveredTools[0]!.arguments.path === "/etc", JSON.stringify(recoveredTools));
const tcWrapped = '<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>';
check("<tool_call> wrapper still recovered", parseToolCalls(tcWrapped)[0]?.name === "read_file");

// ── end-to-end native-tools chat over the OpenAI/SSE path ──
const dir = mkdtempSync(join(tmpdir(), "lcli-vllm-"));
saveConfig({ baseUrl, apiKey: "x", model: "qwen", provider: "auto", toolMode: "auto", cwd: dir });
resetClient();

const toolCalls: string[] = [];
const notices: string[] = [];
let usage: any = null;
let finalText = "";
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "s" },
  { role: "user", content: "list the typescript files" },
];
const hist = await chat(history, {
  onText: (c) => { finalText += c; },
  onToolCall: (n) => toolCalls.push(n),
  onToolResult: () => {},
  onError: (e) => { fail++; console.log("  ✗ onError:", e.message); },
  onNotice: (m) => notices.push(m),
  onUsage: (u) => { usage = u; },
  requestPermission: async () => true,
});

check("used NATIVE tool-calling (no 'prompted' notice)", !notices.some(n => /prompted/i.test(n)), JSON.stringify(notices));
check("request carried native tools + tool_choice", !!lastBody && Array.isArray(lastBody.tools) && lastBody.tool_choice === "auto");
check("request asked for usage (stream_options)", !!lastBody && lastBody.stream_options?.include_usage === true, JSON.stringify(lastBody?.stream_options));
check("native tool call executed (glob_files)", toolCalls.includes("glob_files"), JSON.stringify(toolCalls));
check("usage reported (input tokens from vLLM)", !!usage && usage.inputTokens === 30, JSON.stringify(usage));
check("reached final answer", finalText.includes("done") || String(hist[hist.length - 1]?.content).includes("done"));
check("history has a tool result message", hist.some(m => m.role === "tool"));

server.stop(true);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "VLLM OK" : "VLLM FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
