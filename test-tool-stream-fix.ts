import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${d}`); }
};

function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

let callCount = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    callCount++;
    const turn = callCount;

    const stream = new ReadableStream({
      start(controller) {
        const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));

        if (turn === 1) {
          // Stream two tool calls sequentially but both using index 0
          // Tool Call 1: edit_file
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: null,
            tool_calls: [{ index: 0, id: "call_0", type: "function",
              function: { name: "edit_file", arguments: "" } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":"src/App.jsx",' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, function: { arguments: '"new_string":"code"}' } }] }, finish_reason: null }] }));

          // Tool Call 2: run_server (emitted under same index 0)
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function",
              function: { name: "run_server", arguments: "" } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"command":"bun run dev"}' } }] }, finish_reason: null }] }));

          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          // Turn 2: final text response
          enc(sse({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n");
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});

const run = async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcli-stream-fix-"));
  const baseUrl = `http://localhost:${server.port}/v1`;
  saveConfig({ cwd: dir, baseUrl, apiKey: "test", model: "mock", toolMode: "native" });
  resetClient();

  const toolCalls: { name: string; args: string }[] = [];
  try {
    await chat(
      [
        { role: "system", content: "test" },
        { role: "user", content: "run layout" },
      ],
      {
        onText: () => {},
        onToolCall: (name, args) => {
          toolCalls.push({ name, args });
        },
        onToolResult: () => {},
        onError: (e) => {
          console.error("Integration error:", e);
          fail++;
        },
        requestPermission: async () => true,
      }
    );
  } catch (err) {
    console.error("Chat invocation failed:", err);
    fail++;
  }

  check("Tool calls were correctly separated", toolCalls.length === 2, `got ${toolCalls.length}`);
  if (toolCalls.length === 2) {
    check("First tool call name is edit_file", toolCalls[0]?.name === "edit_file", toolCalls[0]?.name ?? "");
    check("First tool call arguments are correct", !!toolCalls[0]?.args.includes("src/App.jsx"), toolCalls[0]?.args ?? "");
    check("Second tool call name is run_server", toolCalls[1]?.name === "run_server", toolCalls[1]?.name ?? "");
    check("Second tool call arguments are correct", !!toolCalls[1]?.args.includes("bun run dev"), toolCalls[1]?.args ?? "");
  }

  server.stop(true);
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "STREAM-FIX OK" : "STREAM-FIX FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
