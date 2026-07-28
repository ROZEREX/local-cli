// LIVE end-to-end check against a running vLLM server (not part of the suite).
// Proves the full stack: CLI -> vLLM (OpenAI API) -> native/auto tool-calling ->
// a real tool executes -> the loop reaches a final answer.
//
// Requires vLLM serving on http://localhost:8000/v1. Run: bun run test-vllm-live.ts
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BASE = "http://localhost:8000/v1";
const dir = mkdtempSync(join(tmpdir(), "vllm-live-"));
writeFileSync(join(dir, "alpha.ts"), "export const a = 1;\n");
writeFileSync(join(dir, "readme.md"), "# demo\n");

// Discover the served model id so we don't hardcode it.
const models: any = await fetch(`${BASE}/models`).then(r => r.json()).catch(() => null);
const model = models?.data?.[0]?.id;
if (!model) { console.log("✗ vLLM not reachable at " + BASE + " — start the server first."); process.exit(1); }
console.log("model:", model);

saveConfig({ baseUrl: BASE, apiKey: "x", provider: "vllm", model, toolMode: "auto", thinking: false, temperature: 0, contextWindow: 8192, cwd: dir });
resetClient();

const toolCalls: string[] = [];
const notices: string[] = [];
let finalText = "";
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "You are a coding agent with tools. Use them to answer." },
  { role: "user", content: "List the files in the current directory using your tools, then tell me how many there are." },
];

const t0 = Date.now();
const hist = await chat(history, {
  onText: (c) => { finalText += c; },
  onToolCall: (n) => { toolCalls.push(n); console.log("  → tool call:", n); },
  onToolResult: () => {},
  onError: (e) => console.log("  ✗ error:", e.message),
  onNotice: (m) => { notices.push(m); console.log("  · notice:", m); },
  onUsage: (u) => console.log(`  · usage: in=${u.inputTokens} out=${u.outputTokens} ${u.tokPerSec.toFixed(1)} tok/s`),
  requestPermission: async () => true,
});

const ranTool = toolCalls.length > 0;
console.log(`\nelapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("tools executed:", toolCalls.join(", ") || "(none)");
console.log("final answer:", finalText.trim().slice(0, 300) || "(none)");
rmSync(dir, { recursive: true, force: true });
console.log(`\n${ranTool ? "VLLM-LIVE OK — native tool-calling works end-to-end" : "VLLM-LIVE: model answered without calling a tool"}`);
process.exit(ranTool ? 0 : 1);
