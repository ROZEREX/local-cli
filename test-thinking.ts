// Verifies reasoning from a thinking model (Ollama message.thinking) is shown
// live, counts toward progress, and is NOT stored in history; plus the /think
// toggle controls the request.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

let reqThink: any;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/api/version")) return Response.json({ version: "t" });
    if (p.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools", "thinking"] });
    if (p.endsWith("/api/chat")) {
      const body: any = await req.json();
      reqThink = body.think;
      const nd =
        JSON.stringify({ message: { thinking: "Let me reason. " }, done: false }) + "\n" +
        JSON.stringify({ message: { thinking: "17*23 = 391. " }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "The answer is 391." }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 10, eval_duration: 1e9 }) + "\n";
      return new Response(nd, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", thinking: true, cwd: process.cwd() });
resetClient();

let text = "";
const progress: number[] = [];
const hist = await chat(
  [{ role: "system", content: "s" }, { role: "user", content: "17*23?" }],
  { onText: (c) => { text += c; }, onToolCall: () => {}, onToolResult: () => {}, onError: () => { fail++; }, onProgress: (t) => progress.push(t), requestPermission: async () => true }
);

check("request enabled think for a thinking model", reqThink === true);
check("reasoning streamed, wrapped in <think>", text.includes("<think>") && text.includes("Let me reason"));
check("answer streams after the thinking", text.includes("The answer is 391."));
check("progress ticked DURING thinking (not stuck at 0)", progress.length > 0 && progress[progress.length - 1]! > 0, JSON.stringify(progress));
const lastA = hist.filter(m => m.role === "assistant").pop();
check("thinking is NOT stored in history", typeof lastA?.content === "string" && !lastA!.content.includes("Let me reason") && lastA!.content.includes("391"), JSON.stringify(lastA?.content));

// /think off → request must disable thinking
saveConfig({ thinking: false });
reqThink = undefined;
await chat([{ role: "system", content: "s" }, { role: "user", content: "hi" }],
  { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onError: () => {}, requestPermission: async () => true });
check("/think off disables thinking in the request", reqThink === false);

server.stop(true);
console.log(`\n${fail === 0 ? "THINKING OK" : "THINKING FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
