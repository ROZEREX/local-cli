// Tests two reliability features:
//   1. formatLoadedModels — the /ps output (VRAM residency, RAM-spill flag, unload timer).
//   2. The stream watchdog — a turn that hangs with no first token is aborted at
//      the configured cap and retried (warm + retry), recovering on the next try;
//      a fast turn is NOT interrupted.
import "./test-config-setup";
import { formatLoadedModels } from "./src/ollama";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };
function sse(o: any): string { return `data: ${JSON.stringify(o)}\n\n`; }
const textTurn = (t: string) => sse({ choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

// ── 1. formatLoadedModels ─────────────────────────────────────────────────────
{
  const now = Date.parse("2026-01-01T00:00:00Z");
  const out = formatLoadedModels([
    { name: "qwen3:latest", size: 6.1e9, sizeVram: 6.1e9, contextLength: 32768, expiresAt: "2026-01-01T00:28:00Z" },
    { name: "llava:latest", size: 4.8e9, sizeVram: 2.9e9, expiresAt: "2026-01-01T00:04:00Z" },
  ], "qwen3:latest", now);
  check("marks the current model with ▸", /▸ qwen3:latest/.test(out), out);
  check("shows 100% on GPU for a fully-resident model", /100% on GPU/.test(out));
  check("shows the context length", /ctx 32768/.test(out));
  check("shows relative expiry", /expires in 28m/.test(out) && /expires in 4m/.test(out), out);
  check("flags a model partly spilled to RAM", /60% on GPU ⚠ rest in RAM/.test(out), out);
  check("does NOT mark the non-current model", /  llava:latest/.test(out) && !/▸ llava/.test(out));
  check("empty list → friendly message", /No models are currently resident/.test(formatLoadedModels([], "qwen3:latest", now)));
}

// ── 2. Stream watchdog ────────────────────────────────────────────────────────
function mockServer(turnFn: (turn: number) => "hang" | string) {
  let streamCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
      const body: any = await req.json();
      if (!body.stream) return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      streamCalls++;
      const r = turnFn(streamCalls);
      const stream = new ReadableStream({
        start(c) {
          if (r === "hang") return; // never enqueue, never close → a wedged turn
          c.enqueue(new TextEncoder().encode(r));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, streamCalls: () => streamCalls };
}

const run = async () => {
  // 2a. A hung first turn is aborted at the cap and recovers on retry.
  {
    const { server, streamCalls } = mockServer((turn) => turn === 1 ? "hang" : textTurn("Recovered after the watchdog fired."));
    saveConfig({ cwd: process.cwd(), baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", mode: "auto", stallHeartbeatSec: 0, stallTimeoutSec: 1 });
    resetClient();
    const notices: string[] = [];
    const t0 = Date.now();
    const hist = await chat([{ role: "system", content: "t" }, { role: "user", content: "hi" }], { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, onNotice: (m) => notices.push(m) });
    const elapsed = Date.now() - t0;
    check("watchdog aborted the hang (took ~the cap, not forever)", elapsed >= 900 && elapsed < 8000, `elapsed=${elapsed}ms`);
    check("turn was retried after the watchdog fired", streamCalls() >= 2, `calls=${streamCalls()}`);
    const last = hist[hist.length - 1];
    check("recovered with a real answer on retry", last?.role === "assistant" && String(last?.content).includes("Recovered"), JSON.stringify(last));
    check("told the user it was retrying (loading), not compacting", notices.some(n => /loading|retry/i.test(n)) && !notices.some(n => /compact/i.test(n)), notices.join(" | "));
    server.stop(true);
  }

  // 2b. A fast turn is NOT interrupted even with a tiny cap (disarm on first token).
  {
    const { server, streamCalls } = mockServer(() => textTurn("Fast answer."));
    saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, stallHeartbeatSec: 0, stallTimeoutSec: 1 });
    resetClient();
    const hist = await chat([{ role: "system", content: "t" }, { role: "user", content: "hi" }], { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {} });
    check("fast turn runs exactly once (watchdog disarmed)", streamCalls() === 1, `calls=${streamCalls()}`);
    check("fast turn returns its answer intact", String(hist[hist.length - 1]?.content).includes("Fast answer"));
    server.stop(true);
  }

  console.log(`\n${fail === 0 ? "WATCHDOG/PS OK" : "WATCHDOG/PS FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
