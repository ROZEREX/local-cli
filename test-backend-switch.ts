// /backend — atomic backend switching. The original failure mode: switching
// Ollama ↔ vLLM required flipping baseUrl, provider, model, and contextWindow
// by hand, and any stale key (e.g. provider still "vllm" while pointing at
// Ollama, or a vLLM model name sent to Ollama) broke every following message.
// /backend switches all of it in one step and remembers the model per URL.
// Mock servers only — nothing here loads a model or touches the GPU.
import "./test-config-setup";
import { runCommand } from "./src/commands";
import { getConfig, saveConfig, rememberModelForBaseUrl, recallModelForBaseUrl } from "./src/config";
import type { CommandContext } from "./src/commands";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Mock Ollama (native API shape) and mock vLLM (OpenAI + /version shape).
const ollamaSrv = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/version") return Response.json({ version: "0.0.0-test" });
    if (p === "/api/tags") return Response.json({ models: [{ name: "qwen2.5-coder:latest" }, { name: "llama3:8b" }] });
    return new Response("nf", { status: 404 });
  },
});
const vllmSrv = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/version") return new Response("not ollama", { status: 404 });
    if (p === "/version") return Response.json({ version: "0.23.0" });
    if (p === "/v1/models") return Response.json({ object: "list", data: [{ id: "Qwen/Test-AWQ", max_model_len: 8192 }] });
    return new Response("nf", { status: 404 });
  },
});
const ollamaUrl = `http://localhost:${ollamaSrv.port}/v1`;
const vllmUrl = `http://localhost:${vllmSrv.port}/v1`;

const printed: string[] = [];
let pickerOpened = 0;
const ctx = {
  history: [],
  print: (t: string) => printed.push(t),
  clearHistory: () => {}, exit: () => {}, mode: "normal", setMode: () => {},
  compact: async () => {}, saveSession: () => {}, resume: () => {},
  openModelPicker: () => { pickerOpened++; },
  openSessionPicker: () => {}, openFiles: () => {}, addPaths: () => {},
  runInit: () => {}, learnProfile: () => {}, openProfilePicker: () => {}, runAgent: () => {},
} as unknown as CommandContext;

// ── per-URL model memory primitives ──
rememberModelForBaseUrl("http://x:1/v1/", "m1");
check("recall is slash/case-insensitive", recallModelForBaseUrl("http://X:1/v1") === "m1");

// ── start on "ollama" with a model, then switch to the mock vLLM ──
saveConfig({ baseUrl: ollamaUrl, provider: "auto", model: "qwen2.5-coder:latest", apiKey: "ollama" });
await runCommand(`/backend vllm ${vllmUrl}`, ctx);
let cfg = getConfig();
check("switch sets baseUrl", cfg.baseUrl === vllmUrl, cfg.baseUrl);
check("switch pins provider", cfg.provider === "vllm");
check("old backend's model was remembered", recallModelForBaseUrl(ollamaUrl) === "qwen2.5-coder:latest");
check("no model known for new backend → picker opens", pickerOpened === 1);

// Simulate picking a model on vLLM, then switch back to ollama.
saveConfig({ model: "Qwen/Test-AWQ" });
rememberModelForBaseUrl(vllmUrl, "Qwen/Test-AWQ");
await runCommand(`/backend ollama ${ollamaUrl}`, ctx);
cfg = getConfig();
check("switch back sets baseUrl", cfg.baseUrl === ollamaUrl);
check("provider pinned to ollama", cfg.provider === "ollama");
check("ollama model RESTORED automatically", cfg.model === "qwen2.5-coder:latest", cfg.model);
check("no picker needed when model is remembered", pickerOpened === 1);

// And forward again — the vLLM model must come back too.
await runCommand(`/backend vllm ${vllmUrl}`, ctx);
check("vLLM model restored on return", getConfig().model === "Qwen/Test-AWQ", getConfig().model);

// ── status view lists both backends with live state ──
printed.length = 0;
await runCommand("/backend", ctx);
const status = printed.join("\n");
check("status shows the mock vllm as up", /vllm/.test(status) && /up · 1 model/.test(status), status);
check("status marks the current backend", /← current/.test(status));

// ── /config baseUrl resets a stale provider pin ──
saveConfig({ provider: "vllm" });
await runCommand(`/config baseUrl ${ollamaUrl}`, ctx);
check("/config baseUrl resets provider to auto", getConfig().provider === "auto");

// ── bad arg is rejected, config untouched ──
const before = getConfig().baseUrl;
await runCommand("/backend nonsense", ctx);
check("unknown backend arg rejected", getConfig().baseUrl === before);

ollamaSrv.stop(true);
vllmSrv.stop(true);
console.log(`\n${fail === 0 ? "BACKEND-SWITCH OK" : "BACKEND-SWITCH FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
