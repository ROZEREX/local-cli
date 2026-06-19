import "./test-config-setup";
import { ToolLoopGuard } from "./src/think";
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

// ── Unit Tests for ToolLoopGuard ──

// Scenario 1: No loop
let guard = new ToolLoopGuard();
guard.record("read_file", { path: "a.txt" }, "content A");
guard.record("edit_file", { path: "a.txt", target: "A" }, "success");
guard.record("read_file", { path: "a.txt" }, "content B");
check("does not trip on unique sequences", !guard.record("edit_file", { path: "a.txt", target: "B" }, "success"));

// Scenario 2: Cycle of 1 repeats 3 times
guard = new ToolLoopGuard();
guard.record("bash", { cmd: "npm run dev" }, "Port 3000 in use");
guard.record("bash", { cmd: "npm run dev" }, "Port 3000 in use");
check("trips on cycle of 1 repeating 3 times", guard.record("bash", { cmd: "npm run dev" }, "Port 3000 in use"));

// Scenario 3: Cycle of 2 repeats 3 times
guard = new ToolLoopGuard();
// Cycle 1
guard.record("read_file", { path: "x.ts" }, "code");
guard.record("edit_file", { path: "x.ts", change: "1" }, "Error: not found");
// Cycle 2
guard.record("read_file", { path: "x.ts" }, "code");
guard.record("edit_file", { path: "x.ts", change: "1" }, "Error: not found");
// Cycle 3
guard.record("read_file", { path: "x.ts" }, "code");
check("trips on cycle of 2 repeating 3 times", guard.record("edit_file", { path: "x.ts", change: "1" }, "Error: not found"));

// Scenario 4: Non-repeating due to argument change (progress)
guard = new ToolLoopGuard();
guard.record("read_file", { path: "x.ts" }, "code");
guard.record("edit_file", { path: "x.ts", change: "1" }, "Error: not found");
guard.record("read_file", { path: "x.ts" }, "code");
guard.record("edit_file", { path: "x.ts", change: "2" }, "Error: not found"); // arg changed!
guard.record("read_file", { path: "x.ts" }, "code");
check("does not trip if arguments change", !guard.record("edit_file", { path: "x.ts", change: "3" }, "Error: not found"));

// Scenario 5: Non-repeating due to result change (progress)
guard = new ToolLoopGuard();
guard.record("read_file", { path: "x.ts" }, "code1");
guard.record("edit_file", { path: "x.ts" }, "Error: not found");
guard.record("read_file", { path: "x.ts" }, "code2"); // result changed!
guard.record("edit_file", { path: "x.ts" }, "Error: not found");
guard.record("read_file", { path: "x.ts" }, "code3"); // result changed!
check("does not trip if results change", !guard.record("edit_file", { path: "x.ts" }, "Error: not found"));


// ── Integration Test for chat() loop ──

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

        // Mock the loop sequence:
        // Turn 1, 3, 5: calls read_file
        // Turn 2, 4, 6: calls edit_file
        if (turn === 1 || turn === 3 || turn === 5) {
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: null,
            tool_calls: [{ index: 0, id: `call_${turn}`, type: "function",
              function: { name: "read_file", arguments: '{"path":"main.jsx"}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else if (turn === 2 || turn === 4 || turn === 6) {
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: null,
            tool_calls: [{ index: 0, id: `call_${turn}`, type: "function",
              function: { name: "edit_file", arguments: '{"path":"main.jsx","old":"foo","new":"bar"}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          // Turn 7 (should never be reached because loop guard stops it on turn 6)
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

const runIntegrationTest = async () => {
  const dir = mkdtempSync(join(tmpdir(), "lcli-toolloop-"));
  const baseUrl = `http://localhost:${server.port}/v1`;
  saveConfig({ cwd: dir, baseUrl, apiKey: "test", model: "mock", toolMode: "native" });
  resetClient();

  let noticeMsg = "";
  await chat(
    [
      { role: "system", content: "test" },
      { role: "user", content: "edit file" },
    ],
    {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onError: () => {},
      onNotice: (msg) => { noticeMsg = msg; },
      requestPermission: async () => true,
    }
  );

  check("integration: loop was halted (fewer than 7 turns)", callCount < 7, `calls: ${callCount}`);
  check("integration: loop guard notice was triggered", noticeMsg.includes("infinite tool-calling loop"));

  server.stop(true);
  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "TOOL-LOOP OK" : "TOOL-LOOP FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

runIntegrationTest();
