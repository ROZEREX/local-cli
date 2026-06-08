// Tests the anti-stall: when the model announces an action but calls no tool, the
// loop nudges it (instead of ending), and it then acts. Also confirms a real final
// answer is NOT nudged.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(o: any): string { return `data: ${JSON.stringify(o)}\n\n`; }
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Scenario A: turn 1 = "First, I'll look for the config files." (no tool). After a
// nudge, turn 2 calls list_dir. turn 3 final answer.
let aCalls = 0, sawNudge = false;
const serverA = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    const body: any = await req.json();
    if (JSON.stringify(body.messages).includes("did not do it")) sawNudge = true;
    aCalls++;
    const turn = aCalls;
    const stream = new ReadableStream({
      start(c) {
        const enc = (s: string) => c.enqueue(new TextEncoder().encode(s));
        if (turn === 1) { enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "First, I'll look for the configuration files in the project." }, finish_reason: null }] })); enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })); }
        else if (turn === 2) { enc(sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }] }, finish_reason: null }] })); enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })); }
        else { enc(sse({ choices: [{ index: 0, delta: { content: "All set." }, finish_reason: null }] })); enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })); }
        enc("data: [DONE]\n\n"); c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
const dir = mkdtempSync(join(tmpdir(), "lcli-stall-"));

const run = async () => {
  saveConfig({ cwd: dir, baseUrl: `http://localhost:${serverA.port}/v1`, apiKey: "t", model: "mock", mode: "auto" });
  resetClient();
  const toolCalls: string[] = [];
  await chat([{ role: "system", content: "t" }, { role: "user", content: "fix tailwind" }], {
    onText: () => {}, onToolCall: (n) => toolCalls.push(n), onToolResult: () => {}, onError: () => {},
  });
  check("nudge was injected when the model announced but didn't act", sawNudge);
  check("after the nudge the model actually called the tool", toolCalls.includes("list_dir"), JSON.stringify(toolCalls));
  serverA.stop(true);

  // Scenario B: a real final answer (no intent-to-act) is NOT nudged.
  let bCalls = 0, bNudge = false;
  const serverB = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
      const body: any = await req.json();
      if (JSON.stringify(body.messages).includes("did not do it")) bNudge = true;
      bCalls++;
      const stream = new ReadableStream({ start(c) { const enc = (s: string) => c.enqueue(new TextEncoder().encode(s)); enc(sse({ choices: [{ index: 0, delta: { content: "Here is the summary of what I changed. Done." }, finish_reason: null }] })); enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })); enc("data: [DONE]\n\n"); c.close(); } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig({ baseUrl: `http://localhost:${serverB.port}/v1` });
  resetClient();
  await chat([{ role: "system", content: "t" }, { role: "user", content: "summary" }], { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {} });
  check("a genuine final answer is NOT nudged", !bNudge && bCalls === 1, `nudge=${bNudge} calls=${bCalls}`);
  serverB.stop(true);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "STALL OK" : "STALL FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
