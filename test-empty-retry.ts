// Tests the empty-response handling: an empty stream is treated as transient
// (retry, never compact); a reasoning-only turn is recorded with a helpful
// notice; and a persistently-empty model gives up after a bounded number of
// retries with an accurate (non-"context exceeded") message.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(o: any): string { return `data: ${JSON.stringify(o)}\n\n`; }
const toolTurn = (name: string, args: any) =>
  sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `c_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// A mock OpenAI-compatible endpoint. `turnFn(n)` returns the SSE body for the
// n-th STREAMING chat turn; warmUp's non-streaming probe is answered separately
// and does NOT advance the turn counter.
function mockServer(turnFn: (turn: number) => string) {
  let streamCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
      const body: any = await req.json();
      if (!body.stream) {
        // warmUp()'s 1-token probe — answer with plain JSON, don't count it.
        return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      }
      streamCalls++;
      const turn = streamCalls;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(turnFn(turn)));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, streamCalls: () => streamCalls };
}

const emptyTurn = () => sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const textTurn = (t: string) => sse({ choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

const dir = mkdtempSync(join(tmpdir(), "lcli-empty-"));

const run = async () => {
  // ── Scenario A: transient empty, then a real answer on retry ────────────────
  {
    const { server, streamCalls } = mockServer((turn) => turn === 1 ? emptyTurn() : textTurn("Recovered after warm-up."));
    saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", mode: "auto" });
    resetClient();
    const notices: string[] = [];
    const hist = await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "hi" }],
      { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, onNotice: (m) => notices.push(m) }
    );
    check("empty turn was retried (≥2 streaming calls)", streamCalls() >= 2, `calls=${streamCalls()}`);
    const last = hist[hist.length - 1];
    check("history ends with the recovered assistant answer", last?.role === "assistant" && String(last?.content).includes("Recovered"), JSON.stringify(last));
    check("retry notice mentions warming/reload, not compaction", notices.some(n => /warming|reload|retry/i.test(n)) && !notices.some(n => /compact/i.test(n)), notices.join(" | "));
    server.stop(true);
  }

  // ── Scenario B: reasoning-only turn (all <think>, no answer) ────────────────
  {
    const { server, streamCalls } = mockServer(() => textTurn("<think>let me ponder this deeply forever</think>"));
    saveConfig({ baseUrl: `http://localhost:${server.port}/v1` });
    resetClient();
    const notices: string[] = [];
    const hist = await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "hi" }],
      { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, onNotice: (m) => notices.push(m) }
    );
    check("reasoning-only is NOT retried (exactly 1 streaming call)", streamCalls() === 1, `calls=${streamCalls()}`);
    check("reasoning-only turn is recorded as an assistant message", hist[hist.length - 1]?.role === "assistant");
    check("reasoning-only notice points at maxTokens, not context", notices.some(n => /maxTokens|reasoned/i.test(n)) && !notices.some(n => /compact|context window/i.test(n)), notices.join(" | "));
    server.stop(true);
  }

  // ── Scenario C: persistently empty → bounded give-up, accurate message ──────
  {
    const { server, streamCalls } = mockServer(() => emptyTurn());
    saveConfig({ baseUrl: `http://localhost:${server.port}/v1` });
    resetClient();
    const notices: string[] = [];
    const before = [{ role: "system", content: "t" }, { role: "user", content: "hi" }] as any;
    const hist = await chat(before, { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, onNotice: (m) => notices.push(m) });
    check("gives up after 3 CONSECUTIVE empties (3 streaming calls)", streamCalls() === 3, `calls=${streamCalls()}`);
    check("no bogus assistant turn was appended", hist.every((m: any) => m.role !== "assistant"), JSON.stringify(hist.map((m: any) => m.role)));
    check("give-up does NOT blame the model/hardware or tell user to shrink", notices.some(n => /hiccup|resend|several times/i.test(n)) && !notices.some(n => /VRAM|smaller model|context window|doesn't fit/i.test(n)), notices.join(" | "));
    server.stop(true);
  }

  // ── Scenario D: scattered empties during a PRODUCTIVE task must NOT give up ──
  // Reproduces the real bug: a model (gpt-oss:20b) that intermittently returns an
  // empty "reload" turn between successful tool calls. With consecutive counting
  // + reset-on-progress these never accumulate into a false terminal give-up.
  // (Under the old cumulative counter, the 3rd empty here would have killed it.)
  {
    writeFileSync(join(dir, "f.txt"), "hello");
    // tool, empty, tool, empty, tool, empty, final — 3 empties, each cleared by
    // the productive turn before it (varied tools so the loop-guard never trips).
    const script = [
      () => toolTurn("list_dir", {}),
      () => emptyTurn(),
      () => toolTurn("read_file", { path: "f.txt" }),
      () => emptyTurn(),
      () => toolTurn("list_dir", {}),
      () => emptyTurn(),
      () => textTurn("Done exploring."),
    ];
    const { server, streamCalls } = mockServer((turn) => (script[turn - 1] ?? (() => textTurn("Done exploring.")))());
    saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", mode: "auto" });
    resetClient();
    const notices: string[] = [];
    const hist = await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "explore the project" }],
      { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, onNotice: (m) => notices.push(m) }
    );
    check("productive task with scattered empties completes (does NOT give up)", String(hist[hist.length - 1]?.content).includes("Done exploring"), JSON.stringify(hist[hist.length - 1]));
    check("ran all 7 turns (3 empties each recovered)", streamCalls() === 7, `calls=${streamCalls()}`);
    check("never emitted the terminal give-up notice", !notices.some(n => /hiccup|several times|reasoning off/i.test(n)), notices.join(" | "));
    server.stop(true);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "EMPTY-RETRY OK" : "EMPTY-RETRY FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
