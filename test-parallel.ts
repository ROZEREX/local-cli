// Verifies the agent handles multiple files in ONE turn: a single model response
// with several tool calls executes them all (read-only in parallel, writes in
// order), each surfaced as its own tool card.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

let turns = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/api/version")) return Response.json({ version: "test" });
    if (path.endsWith("/api/show")) return Response.json({ capabilities: ["completion"] });
    if (path.endsWith("/api/chat")) {
      const t = ++turns;
      const content = t === 1
        ? 'Creating the files.\n<write_file path="a.txt">aaa</write_file>\n<write_file path="b.txt">bbb</write_file>\n<write_file path="c.txt">ccc</write_file>'
        : "Done — created all three files.";
      const ndjson =
        JSON.stringify({ message: { content }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 10, eval_count: 5, eval_duration: 1e9 }) + "\n";
      return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "lcli-par-"));
saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", cwd: dir });
resetClient();

const calls: string[] = [];
let perms = 0;
await chat(
  [{ role: "system", content: "s" }, { role: "user", content: "make three files" }],
  {
    onText: () => {}, onToolCall: (n) => calls.push(n), onToolResult: () => {}, onError: () => { fail++; },
    requestPermission: async () => { perms++; return true; },
  }
);

check("all three write_file calls ran in ONE turn", calls.filter(c => c === "write_file").length === 3, JSON.stringify(calls));
check("model was called twice (tool turn + final)", turns === 2, `turns=${turns}`);
check("a.txt written", existsSync(join(dir, "a.txt")) && readFileSync(join(dir, "a.txt"), "utf-8") === "aaa");
check("b.txt written", existsSync(join(dir, "b.txt")) && readFileSync(join(dir, "b.txt"), "utf-8") === "bbb");
check("c.txt written", existsSync(join(dir, "c.txt")) && readFileSync(join(dir, "c.txt"), "utf-8") === "ccc");
check("each mutating file asked permission", perms === 3, `perms=${perms}`);

server.stop(true);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PARALLEL OK" : "PARALLEL FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
