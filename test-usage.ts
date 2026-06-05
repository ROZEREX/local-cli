// Verifies real token usage flows from Ollama's native /api/chat done message
// through onUsage. Mocks /api/version + /api/show + /api/chat (NDJSON).
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/api/version")) return Response.json({ version: "test" });
    if (path.endsWith("/api/show")) return Response.json({ capabilities: ["completion"] });
    if (path.endsWith("/api/chat")) {
      const ndjson =
        JSON.stringify({ message: { content: "Hello there" }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 42, eval_count: 7, eval_duration: 1_000_000_000 }) + "\n";
      return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", cwd: process.cwd() });
resetClient();

let usage: any = null;
let answer = "";
const progress: number[] = [];
await chat(
  [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
  {
    onText: (c) => { answer += c; },
    onToolCall: () => {}, onToolResult: () => {}, onError: () => { fail++; },
    onUsage: (u) => { usage = u; },
    onProgress: (t) => { progress.push(t); },
    requestPermission: async () => true,
  }
);

check("onProgress fired live during streaming", progress.length > 0 && progress[progress.length - 1]! > 0, JSON.stringify(progress));
check("onUsage fired", !!usage);
check("input (read) tokens captured", usage?.inputTokens === 42, JSON.stringify(usage));
check("output (write) tokens captured", usage?.outputTokens === 7);
check("tokens/sec computed (7 tok / 1s)", Math.round(usage?.tokPerSec) === 7);
check("answer streamed", /Hello there/.test(answer));

server.stop(true);
console.log(`\n${fail === 0 ? "USAGE OK" : "USAGE FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
