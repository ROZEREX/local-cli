// Tests the two behaviour fixes:
//  1. CHAT MODE — asked for a list, the model must not be able to create files.
//     Enforced in the agent loop, not just the prompt, because models ignore a
//     "don't build" instruction the moment a request sounds like work.
//  2. LOOP GUARD — a repeated tool call must NOT kill the turn by default. It
//     nudges the model and keeps going; the user decides via the Stop button.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { systemPrompt } from "./src/prompt";
import { ToolLoopGuard } from "./src/think";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Mock model. `script` decides what each turn emits, so each test drives its own
// behaviour (build-happy, or stuck repeating one call).
let script: (turn: number) => { tool?: { name: string; args: any }; text?: string } = () => ({ text: "ok" });
let calls = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    const turn = ++calls;
    const step = script(turn);
    const stream = new ReadableStream({
      start(c) {
        const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
        if (step.tool) {
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `c${turn}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          enc(sse({ choices: [{ index: 0, delta: { content: step.text ?? "done" }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n"); c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

const dir = mkdtempSync(join(tmpdir(), "lcli-chatmode-"));

const run = async () => {
  saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "native", mode: "normal", alwaysAllow: [], loopAction: "warn" });

  // ── 1. chat mode blocks file creation ────────────────────────────────────
  // The model does exactly what the user complained about: asked for a list, it
  // reaches for write_file to create a component.
  calls = 0;
  script = (t) => t === 1
    ? { tool: { name: "write_file", args: { path: "TodoList.tsx", content: "export const TodoList = () => null;" } } }
    : { text: "Here is the list: a, b, c" };
  resetClient();
  const results: string[] = [];
  await chat([{ role: "system", content: systemPrompt({ mode: "chat" }) }, { role: "user", content: "give me a list of ideas" }], {
    onText: () => {}, onToolCall: () => {}, onToolResult: (_n, r) => results.push(r), onError: () => {},
    requestPermission: async () => true,
  }, { chatMode: true });

  check("chat mode blocked write_file", results.some(r => r.includes("[chat mode]")));
  check("chat mode created NO file", !existsSync(join(dir, "TodoList.tsx")));
  check("block tells the model to answer in text", results.some(r => r.includes("Write the answer directly")));

  // Same model, normal mode → the file IS written (proves the block is the mode,
  // not a broken mock).
  calls = 0;
  resetClient();
  await chat([{ role: "system", content: systemPrompt({ mode: "normal" }) }, { role: "user", content: "make it" }], {
    onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
    requestPermission: async () => true,
  }, {});
  check("normal mode still writes the file", existsSync(join(dir, "TodoList.tsx")));

  // The prompt has to carry the instruction too, for models that self-censor.
  const chatPrompt = systemPrompt({ mode: "chat" });
  check("chat prompt forbids building", chatPrompt.includes("CHAT MODE"));
  check("chat prompt overrides 'build the full thing'", chatPrompt.includes("Ignore any earlier instruction"));
  check("normal prompt has no chat block", !systemPrompt({ mode: "normal" }).includes("CHAT MODE"));

  // ── 2. loop guard is advisory, not fatal ─────────────────────────────────
  // Same read_file, same args, same result, over and over.
  calls = 0;
  script = (t) => t <= 8 ? { tool: { name: "list_dir", args: { path: "." } } } : { text: "finally done" };
  resetClient();
  let warned = 0, willStopSeen = false, finished = false;
  await chat([{ role: "system", content: "t" }, { role: "user", content: "go" }], {
    onText: () => { finished = true; },
    onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
    onLoopWarning: (i) => { warned++; if (i.willStop) willStopSeen = true; },
    requestPermission: async () => true,
  }, {});
  check("repeated call raised a loop WARNING", warned > 0);
  check("warning did not request a stop (default is advisory)", !willStopSeen);
  check("the turn still completed instead of being killed", finished);

  // Strict opt-in restores the old auto-abort.
  calls = 0;
  saveConfig({ loopAction: "stop" });
  resetClient();
  let stopRequested = false;
  await chat([{ role: "system", content: "t" }, { role: "user", content: "go" }], {
    onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {},
    onLoopWarning: (i) => { if (i.willStop) stopRequested = true; },
    requestPermission: async () => true,
  }, {});
  check("loopAction:\"stop\" does abort", stopRequested);
  saveConfig({ loopAction: "warn" });

  // ── 3. the detector itself is less trigger-happy ─────────────────────────
  const g = new ToolLoopGuard();
  const rec = (n: number) => { let hit = false; for (let i = 0; i < n; i++) hit = g.record("read_file", { path: "a.ts" }, "same") || hit; return hit; };
  check("3 identical calls no longer trip (was the false-positive bar)", !rec(3));
  const g2 = new ToolLoopGuard();
  let tripped = false;
  for (let i = 0; i < 4; i++) tripped = g2.record("read_file", { path: "a.ts" }, "same") || tripped;
  check("4 identical calls do trip", tripped);
  check("guard resets after tripping (no warning spam)", !g2.record("read_file", { path: "a.ts" }, "same"));
  // Different results = real progress, must never trip.
  const g3 = new ToolLoopGuard();
  let t3 = false;
  for (let i = 0; i < 10; i++) t3 = g3.record("bash", { command: "npm test" }, `run ${i}`) || t3;
  check("same tool with CHANGING results never trips", !t3);

  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "CHAT/LOOP OK" : "CHAT/LOOP FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
