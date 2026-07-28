import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.on("unhandledRejection", (err: any) => {
  if (err?.name === "AbortError" || String(err).includes("AbortError")) return;
  console.error("Unhandled Rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err: any) => {
  if (err?.name === "AbortError" || String(err).includes("AbortError")) return;
  console.error("Uncaught Exception:", err);
  process.exit(1);
});


function sse(o: any): string { return `data: ${JSON.stringify(o)}\n\n`; }
const textTurn = (t: string) =>
  sse({ choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] }) +
  sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${d}`); }
};

const dir = mkdtempSync(join(tmpdir(), "lcli-abort-test-"));

const run = async () => {
  // ── Test 1: Fallback to prompted tool-calling on local non-Ollama endpoints ──
  {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Fail capabilities and Ollama checks so detectToolSupport returns null
        if (url.pathname.includes("/api/show") || url.pathname.includes("/api/version") || url.pathname.includes("/api/tags")) {
          return new Response("not found", { status: 404 });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          // If we receive messages, return prompted XML response
          return new Response(
            sse({ choices: [{ index: 0, delta: { role: "assistant", content: "<read_file path=\"x\"></read_file>" }, finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("nf", { status: 404 });
      }
    });

    saveConfig({ cwd: dir, baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto" });
    resetClient();

    const notices: string[] = [];
    const toolCalls: string[] = [];
    await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "read" }],
      {
        onText: () => {},
        onToolCall: (name) => toolCalls.push(name),
        onToolResult: () => {},
        onError: () => {},
        onNotice: (m) => notices.push(m),
        requestPermission: async () => true,
      }
    );

    check(
      "local non-Ollama endpoint triggers prompted tool-calling notice",
      notices.some(n => /no native tool support.*prompted/i.test(n)),
      JSON.stringify(notices)
    );
    check(
      "successfully parsed and executed prompted tool call",
      toolCalls.includes("read_file"),
      JSON.stringify(toolCalls)
    );

    server.stop(true);
  }

  // ── Test 2: Server connection abort retry ───────────────────────────────────
  {
    let completionsCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Fail Ollama checks
        if (url.pathname.includes("/api/show") || url.pathname.includes("/api/version") || url.pathname.includes("/api/tags")) {
          return new Response("not found", { status: 404 });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          completionsCount++;
          if (completionsCount === 1) {
            // First time: close stream abruptly to throw AbortError (simulate server abort)
            const stream = new ReadableStream({
              start(c) {
                c.error(new DOMException("The operation was aborted.", "AbortError"));
              }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
          } else {
            // Second time: return a successful response
            return new Response(textTurn("Recovered from server connection abort."), { headers: { "Content-Type": "text/event-stream" } });
          }
        }
        return new Response("nf", { status: 404 });
      }
    });

    // Force native tool mode to isolate the abort handler in nativeTurn
    saveConfig({ cwd: dir, baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "native" });
    resetClient();

    const notices: string[] = [];
    const hist = await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "hi" }],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: (err) => console.error("Unwanted error:", err),
        onNotice: (m) => notices.push(m)
      }
    );

    check("stream called twice due to retry", completionsCount === 2, `calls=${completionsCount}`);
    check(
      "retry notice was emitted",
      notices.some(n => /empty response.*retry/i.test(n)),
      JSON.stringify(notices)
    );
    const last = hist[hist.length - 1];
    check(
      "chat successfully completed with server abort recovery",
      last?.role === "assistant" && String(last?.content).includes("Recovered"),
      JSON.stringify(last)
    );

    server.stop(true);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ABORT-RETRY OK" : "ABORT-RETRY FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(console.error);
