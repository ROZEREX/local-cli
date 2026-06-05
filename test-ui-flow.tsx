// End-to-end TUI test: render <App/>, type a message, stream a tool call from a
// mock server, approve the permission prompt, and verify the tool card + answer.
import "./test-config-setup";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveConfig } from "./src/config";
import { resetClient } from "./src/llm";
import { App } from "./src/ui/App";

function sse(o: any) { return `data: ${JSON.stringify(o)}\n\n`; }
let calls = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions"))
      return new Response("nf", { status: 404 });
    const body: any = await req.json().catch(() => ({}));
    // Absorb the startup warm-up (non-streaming) without consuming a turn.
    if (body.stream === false) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }
    const turn = ++calls;
    const stream = new ReadableStream({
      start(c) {
        const e = (s: string) => c.enqueue(new TextEncoder().encode(s));
        if (turn === 1) {
          e(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] }));
          e(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"hi.txt","content":"hey"}' } }] }, finish_reason: null }] }));
          e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          for (const t of ["<think>done", "</think>", "All ", "set — ", "wrote **hi.txt**."])
            e(sse({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }));
          e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        e("data: [DONE]\n\n");
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

const dir = mkdtempSync(join(tmpdir(), "localcli-ui-"));
saveConfig({ cwd: dir, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock" });
resetClient();

const inst = render(<App />);
const allFrames = () => inst.frames.join("\n");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(40);
  }
  return false;
}

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};

const run = async () => {
  // Type a message and submit.
  inst.stdin.write("create hi.txt");
  await sleep(120);
  inst.stdin.write("\r");

  // The model asks to write a file → permission prompt should appear.
  const gotPerm = await waitFor(() => /permission|approval/i.test(allFrames()));
  check("permission prompt appears for write_file", gotPerm);

  // Approve it. Retry the keystroke until the prompt resolves — ink-testing's
  // mock stdin can drop a write that lands before useInput's effect subscribes.
  for (let i = 0; i < 25; i++) {
    if (calls >= 2 || existsSync(join(dir, "hi.txt"))) break;
    inst.stdin.write("y");
    await sleep(120);
  }

  // Wait for the final answer to stream in.
  const gotAnswer = await waitFor(() => /wrote/i.test(inst.lastFrame() ?? "") || /wrote/i.test(allFrames()));
  check("final answer rendered", gotAnswer);

  check("user message shown", /create hi\.txt/.test(allFrames()));
  check("write_file tool card shown", /write_file/.test(allFrames()));
  check("file actually written to disk", existsSync(join(dir, "hi.txt")));
  check("file content correct",
    existsSync(join(dir, "hi.txt")) && readFileSync(join(dir, "hi.txt"), "utf-8") === "hey");
  check("model called twice", calls === 2, `(calls=${calls})`);
  check("returns to ready state", await waitFor(() => /ready/.test(inst.lastFrame() ?? "")));

  console.log(`\n${fail === 0 ? "UI FLOW OK" : "UI FLOW FAILED"}: ${pass} passed, ${fail} failed`);
  inst.unmount();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
};

run();
