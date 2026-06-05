// Integration test for the full chat() tool-use loop, using a mock
// OpenAI-compatible streaming server in place of Ollama. Verifies:
//   stream parse → multi-chunk tool-call accumulation → tool execution →
//   tool result fed back → second turn → final answer.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

let callCount = 0;

const server = Bun.serve({
  port: 0, // random free port
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
          // First turn: emit a tool call, arguments split across 3 chunks.
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: null,
            tool_calls: [{ index: 0, id: "call_1", type: "function",
              function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":"out.txt",' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {
            tool_calls: [{ index: 0, function: { arguments: '"content":"hello world"}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          // Second turn: a normal text answer (with a think block for realism).
          enc(sse({ choices: [{ index: 0, delta: { content: "<think>file written</think>" }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: { content: "Done — wrote out.txt." }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n");
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  },
});

const baseUrl = `http://localhost:${server.port}/v1`;
const dir = mkdtempSync(join(tmpdir(), "localcli-llm-"));
saveConfig({ cwd: dir, baseUrl, apiKey: "test", model: "mock" });
resetClient(); // ensure the OpenAI client picks up the new baseUrl

const run = async () => {
  let finalText = "";
  const toolCalls: string[] = [];
  const toolResults: string[] = [];

  const history = await chat(
    [
      { role: "system", content: "test" },
      { role: "user", content: "write out.txt" },
    ],
    {
      onText: (c) => { finalText += c; },
      onToolCall: (name) => toolCalls.push(name),
      onToolResult: (_n, r) => toolResults.push(r),
      onError: (e) => { console.error("stream error:", e.message); fail++; },
      requestPermission: async () => true,
    }
  );

  check("model was called twice (tool turn + answer turn)", callCount === 2, `got ${callCount}`);
  check("write_file tool was invoked", toolCalls.includes("write_file"), JSON.stringify(toolCalls));
  check("file was actually created on disk", existsSync(join(dir, "out.txt")));
  check("file has correct content",
    existsSync(join(dir, "out.txt")) && readFileSync(join(dir, "out.txt"), "utf-8") === "hello world",
    existsSync(join(dir, "out.txt")) ? readFileSync(join(dir, "out.txt"), "utf-8") : "(missing)");
  check("tool result fed back", toolResults.some(r => r.includes("Written")), JSON.stringify(toolResults));
  check("final answer text received", finalText.includes("Done — wrote out.txt."), JSON.stringify(finalText));
  check("history ends with assistant answer",
    history[history.length - 1]?.role === "assistant", history[history.length - 1]?.role);

  // history should contain: system, user, assistant(tool_call), tool, assistant(answer)
  const roles = history.map(m => m.role).join(",");
  check("history shape is correct", roles === "system,user,assistant,tool,assistant", roles);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
};

run();
