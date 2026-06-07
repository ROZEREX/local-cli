// Reproduces the qwen2.5-coder bug: a native-capable model emits a tool call as
// a ```json block in CONTENT (with a made-up name "read_dir") instead of using
// the native tool_calls field. The loop must still parse it, normalize the name
// to list_dir, execute it, feed the result back, and reach a final answer.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { canonicalToolName } from "./src/tools/executor";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Quick unit checks on the alias map.
check("read_dir → list_dir", canonicalToolName("read_dir") === "list_dir");
check("create_file → write_file", canonicalToolName("create_file") === "write_file");
check("search → grep_files", canonicalToolName("search") === "grep_files");
check("known names pass through", canonicalToolName("list_dir") === "list_dir");

let callCount = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    callCount++;
    const turn = callCount;
    const stream = new ReadableStream({
      start(controller) {
        const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
        if (turn === 1) {
          // Narrated tool call as a ```json fence in content — NOT tool_calls.
          const narration = 'I will look around.\n```json\n{\n  "name": "read_dir",\n  "arguments": { "path": "." }\n}\n```';
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: narration }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        } else {
          enc(sse({ choices: [{ index: 0, delta: { content: "I can see the files now. Done." }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n");
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

const baseUrl = `http://localhost:${server.port}/v1`;
const dir = mkdtempSync(join(tmpdir(), "localcli-nf-"));
writeFileSync(join(dir, "marker.txt"), "x");
saveConfig({ cwd: dir, baseUrl, apiKey: "test", model: "mock", toolMode: "native" });
resetClient();

const run = async () => {
  let finalText = "";
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  await chat(
    [{ role: "system", content: "test" }, { role: "user", content: "look around" }],
    {
      onText: (c) => { finalText += c; },
      onToolCall: (name) => toolCalls.push(name),
      onToolResult: (_n, r) => toolResults.push(r),
      onError: (e) => { console.error("stream error:", e.message); fail++; },
      requestPermission: async () => true,
    }
  );

  check("model was called twice (fallback ran, loop continued)", callCount === 2, `got ${callCount}`);
  check("narrated tool call was executed as list_dir", toolCalls.includes("list_dir"), JSON.stringify(toolCalls));
  check("list_dir actually returned the directory contents", toolResults.some(r => r.includes("marker.txt")), JSON.stringify(toolResults));
  check("final answer received after the fallback", finalText.includes("Done"), JSON.stringify(finalText));

  console.log(`\n${fail === 0 ? "NATIVE-FALLBACK OK" : "NATIVE-FALLBACK FAILED"}: ${pass} passed, ${fail} failed`);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
};

run();
