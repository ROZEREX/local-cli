// Regression test for the gpt-oss "leaked tool call" bug. Ollama's harmony
// decoder sometimes drops a tool call's function name (it lived in the channel
// header "…to=functions.write_file…") and leaks just the ARGUMENTS as bare JSON
// in message.content: {"path":…,"content":…}. parseToolCalls can't recognize it
// (no `name`), so the call used to dead-end as a JSON "final answer". We now
// infer the tool from the argument shape and run it.
import "./test-config-setup";
import { parseLeakedToolCall } from "./src/toolparse";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── unit: inference is precise and conservative ──
const wf = parseLeakedToolCall('{"path":"tailwind.config.js","content":"module.exports = {}"}');
check("{path,content} → write_file", wf.length === 1 && wf[0]!.name === "write_file", JSON.stringify(wf));

const ef = parseLeakedToolCall('{"path":"a.js","old_string":"x","new_string":"y"}');
check("{path,old_string,new_string} → edit_file", ef.length === 1 && ef[0]!.name === "edit_file", JSON.stringify(ef));

check("{command} is ambiguous (bash vs run_server) → skip", parseLeakedToolCall('{"command":"ls"}').length === 0);
check("{path} alone is ambiguous → skip", parseLeakedToolCall('{"path":"x"}').length === 0);
check("named object is left to parseToolCalls", parseLeakedToolCall('{"name":"write_file","arguments":{}}').length === 0);
check("foreign key blocks inference", parseLeakedToolCall('{"path":"x","content":"y","bogus":1}').length === 0);
check("JSON embedded in prose is ignored", parseLeakedToolCall('Here you go: {"path":"x","content":"y"}').length === 0);
check("non-JSON prose ignored", parseLeakedToolCall("All done — the file is written.").length === 0);

// ── integration: a leaked write_file actually runs and the loop continues ──
const dir = mkdtempSync(join(tmpdir(), "localcli-leak-"));
let turn = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/api/version")) return Response.json({ version: "t" });
    if (p.endsWith("/api/tags")) return Response.json({ models: [] });
    if (p.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools", "thinking"] });
    if (p.endsWith("/api/chat")) {
      turn++;
      const body =
        turn === 1
          // Leaked write_file: args as bare JSON content, NO tool_calls field.
          ? { message: { content: '{"path":"tailwind.config.js","content":"module.exports = { content: [] }\\n"}' }, done: false }
          : { message: { content: "Created tailwind.config.js — done." }, done: false };
      const nd =
        JSON.stringify(body) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 6, eval_duration: 1e9 }) + "\n";
      return new Response(nd, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "native", thinking: false, cwd: dir });
resetClient();

const toolCalls: string[] = [];
const notices: string[] = [];
let finalText = "";
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "s" },
  { role: "user", content: "set up tailwind config" },
];
const hist = await chat(history, {
  onText: (c) => { finalText += c; },
  onToolCall: (n) => toolCalls.push(n),
  onToolResult: () => {},
  onError: () => { fail++; },
  onNotice: (m) => notices.push(m),
  requestPermission: async () => true,
});

check("leaked call executed as write_file", toolCalls.includes("write_file"), JSON.stringify(toolCalls));
check("file was actually written to disk", existsSync(join(dir, "tailwind.config.js")));
check("file has the leaked content", existsSync(join(dir, "tailwind.config.js")) && readFileSync(join(dir, "tailwind.config.js"), "utf8").includes("module.exports"));
check("a recovery notice was shown", notices.some(n => /recovered/i.test(n)), JSON.stringify(notices));
check("loop continued to a final answer", finalText.includes("done") || String(hist[hist.length - 1]?.content).includes("done"));
const asst = hist.find(m => m.role === "assistant" && (m as any).tool_calls);
check("history stored a proper native tool_call (not raw JSON content)", !!asst && (asst as any).tool_calls[0].function.name === "write_file", JSON.stringify(asst));

server.stop(true);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "LEAKED-TOOLCALL OK" : "LEAKED-TOOLCALL FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
