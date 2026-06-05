// LIVE test against the real Ollama + deepseek-coder-v2-lite model.
// Proves prompted tool-calling works end-to-end with a model that has NO native
// tool support. Requires Ollama running with the model pulled. Not in the CI
// suite (slow + needs the model). Run: bun run test-deepseek-live.ts
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { systemPrompt } from "./src/prompt";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const MODEL = "mannix/deepseek-coder-v2-lite-instruct:latest";
const dir = mkdtempSync(join(tmpdir(), "localcli-deepseek-"));

saveConfig({
  cwd: dir,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: MODEL,
  toolMode: "auto",
});
resetClient();

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};

const run = async () => {
  console.log(`Running live test against ${MODEL} …(this can take a minute)\n`);

  let noticed = false;
  const toolCalls: string[] = [];
  let answer = "";

  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt({ mode: "normal" }) },
    { role: "user", content: 'Create a working countdown timer as a single file timer.html — it should let me start, stop and reset, and actually count down. Create the file.' },
  ];

  const final = await chat(history, {
    onText: (c) => { answer += c; process.stdout.write(c); },
    onToolCall: (name, args) => { toolCalls.push(name); process.stdout.write(`\n[tool] ${name} ${args}\n`); },
    onToolResult: (_n, r) => process.stdout.write(`[result] ${r.slice(0, 120)}\n`),
    onError: (e) => { fail++; console.log("\nstream error:", e.message); },
    onNotice: (m) => { noticed = true; console.log(`[notice] ${m}`); },
    requestPermission: async () => true, // unattended
  });

  const fp = join(dir, "timer.html");
  const content = existsSync(fp) ? readFileSync(fp, "utf-8") : "";
  console.log("\n\n──────── checks ────────");
  check("fell back to prompted tool-calling (notice fired)", noticed);
  check("model issued a write_file tool call", toolCalls.includes("write_file"), `tools=${JSON.stringify(toolCalls)}`);
  check("timer.html was actually created", existsSync(fp));
  check("file is a real page, not a stub (>400 chars)", content.length > 400, `len=${content.length}`);
  check("contains timer logic (setInterval / setTimeout)", /setInterval|setTimeout/.test(content));
  check("contains start/stop/reset controls", /start/i.test(content) && /stop/i.test(content) && /reset/i.test(content));
  check("did NOT dump the file into the chat answer", !answer.includes("<!DOCTYPE") && !answer.includes("<script"));
  check("conversation produced a final assistant message", final[final.length - 1]?.role === "assistant");
  console.log(`\n  (timer.html is ${content.length} chars)`);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "DEEPSEEK LIVE OK" : "DEEPSEEK LIVE FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
