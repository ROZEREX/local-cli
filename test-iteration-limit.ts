import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.on("unhandledRejection", (err: any) => {
  console.error("Unhandled Rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err: any) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

function sse(o: any): string { return `data: ${JSON.stringify(o)}\n\n`; }

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${d}`); }
};

const dir = mkdtempSync(join(tmpdir(), "lcli-iter-test-"));

const run = async () => {
  // ── Test 1: Hit iteration limit and verify notice ──
  {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        // Fail capabilities and Ollama checks
        if (url.pathname.includes("/api/show") || url.pathname.includes("/api/version") || url.pathname.includes("/api/tags")) {
          return new Response("not found", { status: 404 });
        }
        if (url.pathname.endsWith("/chat/completions")) {
          callCount++;
          // Always return a prompted tool call to keep the loop going
          return new Response(
            sse({ choices: [{ index: 0, delta: { role: "assistant", content: `<read_file path="mock-file-${callCount}.txt"></read_file>` }, finish_reason: null }] }) +
            sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("nf", { status: 404 });
      }
    });

    // Set maxIterations to 2
    saveConfig({ cwd: dir, baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "prompted", maxIterations: 2 });
    resetClient();

    const notices: string[] = [];
    const toolCalls: string[] = [];
    const hist = await chat(
      [{ role: "system", content: "t" }, { role: "user", content: "run" }],
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
      "chat loop executes exactly maxIterations (2)",
      callCount === 2,
      `calls=${callCount}`
    );
    check(
      "iteration limit notice is triggered",
      notices.some(n => /reached the safety limit of 2/i.test(n)),
      JSON.stringify(notices)
    );

    server.stop(true);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "ITERATION-LIMIT OK" : "ITERATION-LIMIT FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(console.error);
