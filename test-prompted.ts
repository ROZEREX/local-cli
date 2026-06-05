// Tests prompted tool-calling for models without native tool support.
//  - parseToolCalls handles the XML format (raw bodies), plus JSON fallbacks.
//  - ProseFilter hides tool markup from the streamed display.
//  - end-to-end: a full multi-line file is written verbatim (the real bug), via
//    capability detection AND the 400 "does not support tools" fallback.
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { parseToolCalls, ProseFilter } from "./src/toolparse";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};
function sse(o: any) { return `data: ${JSON.stringify(o)}\n\n`; }

// A realistic file body — quotes, braces, backticks, ${} — the stuff that breaks
// JSON-string escaping and made models bail to markdown instead of calling tools.
const FILE_BODY = `<!DOCTYPE html>
<html>
<body>
  <div id="t">00:00</div>
  <script>
    let s = 0;
    function tick() { s++; document.getElementById("t").textContent = \`\${s}\`; }
    setInterval(tick, 1000);
  </script>
</body>
</html>`;

function makeServer(opts: { nativeShow: boolean; reject400: boolean }) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/api/show")) return Response.json({ capabilities: opts.nativeShow ? ["completion", "tools"] : ["completion"] });
      if (path.endsWith("/api/version")) return Response.json({ version: "test" });
      if (path.endsWith("/api/chat")) {
        const body: any = await req.json();
        if (body.tools && opts.reject400) {
          return Response.json({ error: { message: "registry/mock does not support tools" } }, { status: 400 });
        }
        const isFirst = (body.messages ?? []).length <= 3;
        const stream = new ReadableStream({
          start(c) {
            const e = (s: string) => c.enqueue(new TextEncoder().encode(s));
            if (isFirst) {
              const chunks = [
                "Sure, creating the timer.\n",
                '<write_file path="timer.html">\n',
                FILE_BODY,
                "\n</write_file>",
              ];
              for (const ch of chunks) e(JSON.stringify({ message: { role: "assistant", content: ch }, done: false }) + "\n");
              e(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
            } else {
              e(JSON.stringify({ message: { role: "assistant", content: "Created timer.html — open it in a browser." }, done: false }) + "\n");
              e(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (!path.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
      const body: any = await req.json();
      if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      if (body.tools && opts.reject400) {
        return Response.json({ error: { message: "registry/mock does not support tools" } }, { status: 400 });
      }
      const isFirst = (body.messages ?? []).length <= 3;
      const stream = new ReadableStream({
        start(c) {
          const e = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (isFirst) {
            // Prose + an XML write_file with raw multi-line content.
            const chunks = [
              "Sure, creating the timer.\n",
              '<write_file path="timer.html">\n',
              FILE_BODY,
              "\n</write_file>",
            ];
            for (const ch of chunks) e(sse({ choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] }));
            e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          } else {
            e(sse({ choices: [{ index: 0, delta: { content: "Created timer.html — open it in a browser." }, finish_reason: null }] }));
            e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          }
          e("data: [DONE]\n\n");
          c.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return server;
}

async function runScenario(label: string, opts: { nativeShow: boolean; reject400: boolean }) {
  const server = makeServer(opts);
  const dir = mkdtempSync(join(tmpdir(), "localcli-prompted-"));
  saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock-" + server.port, toolMode: "auto" });
  resetClient();

  let noticed = false, answer = "";
  const tools: string[] = [];
  await chat(
    [{ role: "system", content: "sys" }, { role: "user", content: "create a timer" }],
    {
      onText: (c) => { answer += c; },
      onToolCall: (n) => tools.push(n),
      onToolResult: () => {},
      onError: () => { fail++; },
      onNotice: () => { noticed = true; },
      requestPermission: async () => true,
    }
  );

  const fp = join(dir, "timer.html");
  check(`[${label}] used prompted mode`, noticed);
  check(`[${label}] called write_file`, tools.includes("write_file"));
  check(`[${label}] file created`, existsSync(fp));
  check(`[${label}] FULL multi-line content written verbatim`,
    existsSync(fp) && readFileSync(fp, "utf-8") === FILE_BODY,
    existsSync(fp) ? `len ${readFileSync(fp, "utf-8").length} vs ${FILE_BODY.length}` : "missing");
  check(`[${label}] raw file markup hidden from chat`, !answer.includes("<!DOCTYPE") && !answer.includes("write_file"));
  check(`[${label}] prose + final answer shown`, /creating the timer/i.test(answer) && /Created timer\.html/.test(answer));

  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}

const run = async () => {
  // ── XML parser units ──
  const w = parseToolCalls('<write_file path="a.html">\n' + FILE_BODY + '\n</write_file>')[0];
  check("XML write_file parsed", w?.name === "write_file");
  check("XML write_file content is exact raw body", w?.arguments.content === FILE_BODY);
  // A model wrapping the file in a ```fence``` must not leak the fence into the file.
  const fenced = parseToolCalls('<write_file path="a.js">\n```js\nconst x = 1;\n```\n</write_file>')[0];
  check("write_file strips a wrapping ``` code fence", fenced?.arguments.content === "const x = 1;", JSON.stringify(fenced?.arguments.content));
  // But a file that merely CONTAINS a fence mid-content is left intact.
  const md = parseToolCalls('<write_file path="r.md">\n# Title\n\n```js\ncode\n```\n\nmore\n</write_file>')[0];
  check("write_file keeps inner fences when not the whole body", (md?.arguments.content ?? "").includes("# Title") && (md?.arguments.content ?? "").includes("more"));
  check("XML edit_file search/replace", (() => {
    const e = parseToolCalls('<edit_file path="x"><search>\nold\n</search><replace>\nnew\n</replace></edit_file>')[0];
    return e?.name === "edit_file" && e.arguments.old_string === "old" && e.arguments.new_string === "new";
  })());
  check("XML edit_file search/replace_with", (() => {
    const e = parseToolCalls('<edit_file path="x"><search>\nold\n</search><replace_with>\nnew\n</replace_with></edit_file>')[0];
    return e?.name === "edit_file" && e.arguments.old_string === "old" && e.arguments.new_string === "new";
  })());
  check("XML bash body", parseToolCalls("<bash>npm test</bash>")[0]?.arguments.command === "npm test");
  check("XML read_file attrs", parseToolCalls('<read_file path="src/x.ts"></read_file>')[0]?.arguments.path === "src/x.ts");
  check("XML grep with offset/limit numbers", (() => {
    const r = parseToolCalls('<read_file path="x" offset="5" limit="10"></read_file>')[0];
    return r?.arguments.offset === 5 && r.arguments.limit === 10;
  })());
  check("prose before tool tag still extracts call", parseToolCalls('Let me do that.\n<bash>ls</bash>')[0]?.name === "bash");
  check("JSON <tool_call> fallback still works", parseToolCalls('<tool_call>{"name":"list_dir","arguments":{}}</tool_call>')[0]?.name === "list_dir");
  check("plain prose → no calls", parseToolCalls("Here is how a timer works, conceptually.").length === 0);

  // ── ProseFilter ──
  const pf = new ProseFilter();
  let shown = "";
  for (const ch of ['I will create it.\n', '<write_file path="t.html">\n', FILE_BODY, "\n</write_file>"]) shown += pf.push(ch);
  shown += pf.flush();
  check("ProseFilter shows prose", shown.includes("I will create it."));
  check("ProseFilter hides tool body", !shown.includes("<!DOCTYPE") && !shown.includes("write_file"));

  // ── integration ──
  await runScenario("detect", { nativeShow: false, reject400: false });
  await runScenario("400-fallback", { nativeShow: true, reject400: true });

  console.log(`\n${fail === 0 ? "PROMPTED OK" : "PROMPTED FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
