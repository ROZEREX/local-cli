// Regression test for the gpt-oss "error parsing tool call" 500 from Ollama's
// native /api/chat. Ollama's server-side harmony tool-call parser intermittently
// chokes on malformed JSON the model emits (raw='{"}') and returns a 500. That is
// an Ollama bug, NOT missing tool support — so the loop must retry ONCE and then
// fall back to prompted tool-calling (which sends no `tools` and never invokes
// that parser), instead of dumping the raw error and giving up.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${e}`)); };

let nativeCalls = 0;   // /api/chat requests that carried `tools` (native)
let promptedCalls = 0; // /api/chat requests without `tools` (prompted fallback)
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/api/version")) return Response.json({ version: "t" });
    if (p.endsWith("/api/tags")) return Response.json({ models: [] });
    if (p.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools", "thinking"] });
    if (p.endsWith("/api/chat")) {
      const body: any = await req.json();
      if (body.tools) {
        // Native path: reproduce Ollama's harmony tool-parse 500.
        nativeCalls++;
        return new Response(
          JSON.stringify({ error: "error parsing tool call: raw='{\"}', err=unexpected end of JSON input" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      // Prompted fallback path (no tools): the model answers normally.
      promptedCalls++;
      const nd =
        JSON.stringify({ message: { content: "Recovered via prompted mode — done." }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 6, eval_duration: 1e9 }) + "\n";
      return new Response(nd, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", thinking: false, cwd: process.cwd() });
resetClient();

const notices: string[] = [];
let errored = false;
let finalText = "";
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "s" },
  { role: "user", content: "do the thing" },
];

const hist = await chat(history, {
  onText: (c) => { finalText += c; },
  onToolCall: () => {},
  onToolResult: () => {},
  onError: () => { errored = true; },
  onNotice: (m) => notices.push(m),
  requestPermission: async () => true,
});

check("native /api/chat was tried twice (one retry, then give up on native)", nativeCalls === 2, `got ${nativeCalls}`);
check("fell back to prompted (no-tools) request", promptedCalls >= 1, `got ${promptedCalls}`);
check("did NOT surface the raw 500 via onError", !errored);
check("retry notice mentions the parse hiccup", notices.some(n => /retry/i.test(n) && /tool call/i.test(n)), JSON.stringify(notices));
check("fallback notice explains the switch to prompted", notices.some(n => /prompted/i.test(n)), JSON.stringify(notices));
check("turn completed with the recovered answer", String(hist[hist.length - 1]?.content).includes("Recovered") || finalText.includes("Recovered"), JSON.stringify(hist[hist.length - 1]));

server.stop(true);
console.log(`\n${fail === 0 ? "TOOL-PARSE-FALLBACK OK" : "TOOL-PARSE-FALLBACK FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
