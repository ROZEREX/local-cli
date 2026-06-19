// Root-cause test for the gpt-oss "empty response" bug: tool results must be
// sent to Ollama's native /api/chat as proper `tool` messages paired with their
// function (via tool_name), NOT as plain `user` messages. Sending them as user
// messages left harmony models (gpt-oss) with "unanswered" tool calls, so the
// model eventually returned an empty turn instead of finalizing.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${e}`)); };

let captured: any = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/api/version")) return Response.json({ version: "t" });
    if (p.endsWith("/api/tags")) return Response.json({ models: [] });
    if (p.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools", "thinking"] });
    if (p.endsWith("/api/chat")) {
      captured = await req.json();
      const nd =
        JSON.stringify({ message: { content: "All done — I read the file." }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 6, eval_duration: 1e9 }) + "\n";
      return new Response(nd, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", thinking: false, cwd: process.cwd() });
resetClient();

// A conversation that already contains a completed tool call + its result — the
// exact shape that was breaking gpt-oss after a run of file reads.
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "s" },
  { role: "user", content: "read the file" },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }] } as any,
  { role: "tool", tool_call_id: "call_1", content: "file contents here" } as any,
];

const hist = await chat(history, { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => { fail++; }, requestPermission: async () => true });

const sent: any[] = captured?.messages ?? [];
const toolMsg = sent.find((m) => m.role === "tool");
const userMsgs = sent.filter((m) => m.role === "user");
const asstMsg = sent.find((m) => m.role === "assistant" && m.tool_calls);

check("request was captured", !!captured, JSON.stringify(captured));
check("tool result is sent as role:tool (not converted to user)", !!toolMsg, JSON.stringify(sent.map((m) => m.role)));
check("tool message carries tool_name pairing it to its call", toolMsg?.tool_name === "read_file", JSON.stringify(toolMsg));
check("tool message keeps the raw result content", typeof toolMsg?.content === "string" && toolMsg.content.includes("file contents here"));
check("no '[Tool result for call …]' user-message wrapper remains", !userMsgs.some((m) => String(m.content).includes("[Tool result for call")), JSON.stringify(userMsgs));
check("assistant tool_calls preserved with parsed (object) arguments", asstMsg?.tool_calls?.[0]?.function?.arguments?.path === "x", JSON.stringify(asstMsg?.tool_calls));
check("turn completed with the model's final answer", String(hist[hist.length - 1]?.content).includes("All done"), JSON.stringify(hist[hist.length - 1]));

server.stop(true);
console.log(`\n${fail === 0 ? "TOOL-MSG-FORMAT OK" : "TOOL-MSG-FORMAT FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
