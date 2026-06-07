// Tests the ask_user interactive tool: the model asks the user to choose, the
// runtime surfaces the question via requestChoice, and the answer is fed back so
// the model can continue. Also covers prompted-format (XML) parsing of options.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { parseToolCalls } from "./src/toolparse";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function sse(obj: any): string { return `data: ${JSON.stringify(obj)}\n\n`; }
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── prompted XML parsing: options from the body ──
const parsed = parseToolCalls('<ask_user question="Which package manager?">bun|npm|pnpm</ask_user>');
check("prompted ask_user parses question", parsed[0]?.name === "ask_user" && parsed[0]?.arguments.question === "Which package manager?", JSON.stringify(parsed));
check("prompted ask_user parses options from body", JSON.stringify(parsed[0]?.arguments.options) === JSON.stringify(["bun", "npm", "pnpm"]), JSON.stringify(parsed[0]?.arguments));

// ── end-to-end: native ask_user tool call → picker → answer fed back ──
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
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: null,
            tool_calls: [{ index: 0, id: "call_1", type: "function",
              function: { name: "ask_user", arguments: '{"question":"Which package manager should I use?","options":["bun","npm","pnpm"]}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          enc(sse({ choices: [{ index: 0, delta: { content: "Great, using bun. Installing now." }, finish_reason: null }] }));
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
const dir = mkdtempSync(join(tmpdir(), "localcli-ask-"));
saveConfig({ cwd: dir, baseUrl, apiKey: "test", model: "mock", toolMode: "native" });
resetClient();

const run = async () => {
  let askedQuestion = "";
  let askedOptions: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let finalText = "";

  await chat(
    [{ role: "system", content: "test" }, { role: "user", content: "set up the project" }],
    {
      onText: (c) => { finalText += c; },
      onToolCall: (name) => toolCalls.push(name),
      onToolResult: (_n, r) => toolResults.push(r),
      onError: (e) => { console.error("stream error:", e.message); fail++; },
      requestPermission: async () => true,
      requestChoice: async (q, opts) => { askedQuestion = q; askedOptions = opts; return "bun"; },
    }
  );

  check("ask_user invoked the picker", askedQuestion.includes("package manager"), askedQuestion);
  check("picker received the options", JSON.stringify(askedOptions) === JSON.stringify(["bun", "npm", "pnpm"]), JSON.stringify(askedOptions));
  check("ask_user appears as a tool call", toolCalls.includes("ask_user"), JSON.stringify(toolCalls));
  check("the chosen answer is fed back to the model", toolResults.some(r => r.includes('answered "bun"')), JSON.stringify(toolResults));
  check("model continued after the answer", finalText.includes("using bun"), finalText);
  check("model called twice (ask turn + continue)", callCount === 2, `got ${callCount}`);

  console.log(`\n${fail === 0 ? "ASK-USER OK" : "ASK-USER FAILED"}: ${pass} passed, ${fail} failed`);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
};

run();
