// Tests the persistent always-allow list: a tool in config.alwaysAllow must NOT
// trigger a permission prompt, even in normal (non-auto) mode.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Mock model: turn 1 calls bash, turn 2 answers.
let calls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    calls++;
    const turn = calls;
    const stream = new ReadableStream({
      start(c) {
        const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
        if (turn === 1) {
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          enc(sse({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n"); c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
const dir = mkdtempSync(join(tmpdir(), "lcli-allow-"));

const run = async () => {
  // bash is always-allowed → permission callback must NOT be called.
  saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", alwaysAllow: ["bash"], mode: "normal" });
  resetClient();
  let prompted = false;
  await chat([{ role: "system", content: "t" }, { role: "user", content: "run echo" }], {
    onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
    requestPermission: async () => { prompted = true; return true; },
  });
  check("always-allowed bash did NOT prompt", !prompted);

  // Not in the list → it DOES prompt.
  calls = 0;
  saveConfig({ alwaysAllow: [] });
  resetClient();
  let prompted2 = false;
  await chat([{ role: "system", content: "t" }, { role: "user", content: "run echo" }], {
    onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
    requestPermission: async () => { prompted2 = true; return true; },
  });
  check("non-allowed bash DOES prompt", prompted2);

  server.stop(true); rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ALLOW OK" : "ALLOW FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
