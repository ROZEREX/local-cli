// Tests for the new features: plan mode (mutating tools blocked), session
// save/load, compaction history shape, and project-context loading.
import "./test-config-setup";
import { chat, resetClient, compactHistory } from "./src/llm";
import { saveConfig } from "./src/config";
import { systemPrompt } from "./src/prompt";
import { saveSession, loadSession, listSessions, latestSession, deleteSession, newSessionId, deriveTitle } from "./src/session";
import { findProjectContext } from "./src/context";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};

function sse(o: any) { return `data: ${JSON.stringify(o)}\n\n`; }

const run = async () => {
  // ─── Plan mode: a mutating tool call must be blocked, no second call ───────
  let calls = 0;
  const planServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
      const turn = ++calls;
      const stream = new ReadableStream({
        start(c) {
          const e = (s: string) => c.enqueue(new TextEncoder().encode(s));
          if (turn === 1) {
            // model tries to write a file (should be blocked in plan mode)
            e(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "p1", type: "function", function: { name: "write_file", arguments: '{"path":"x.txt","content":"no"}' } }] }, finish_reason: null }] }));
            e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
          } else {
            e(sse({ choices: [{ index: 0, delta: { content: "Here is my plan: 1. do X" }, finish_reason: null }] }));
            e(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
          }
          e("data: [DONE]\n\n");
          c.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "localcli-feat-"));
  saveConfig({ cwd: dir, baseUrl: `http://localhost:${planServer.port}/v1`, apiKey: "t", model: "mock" });
  resetClient();

  let blockedResult = "";
  let permissionAsked = false;
  const planHistory = await chat(
    [{ role: "system", content: "test" }, { role: "user", content: "change the file" }],
    {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: (_n, r) => { if (r.includes("plan mode")) blockedResult = r; },
      onError: () => {},
      requestPermission: async () => { permissionAsked = true; return true; },
    },
    { planMode: true }
  );

  check("plan mode blocks the mutating tool", blockedResult.includes("plan mode"), blockedResult);
  check("plan mode never asks permission for blocked tool", permissionAsked === false);
  check("plan mode did NOT write the file", !existsSync(join(dir, "x.txt")));
  check("plan mode still completes the turn (model presents plan)", calls === 2, `calls=${calls}`);
  check("plan history ends with assistant plan text",
    planHistory[planHistory.length - 1]?.role === "assistant");
  planServer.stop(true);

  // ─── Session save / load roundtrip ─────────────────────────────────────────
  saveConfig({ cwd: dir });
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "build me a thing please" },
    { role: "assistant", content: "done" },
  ];
  const id = newSessionId();
  saveSession({ id, title: deriveTitle(history), model: "mock", cwd: dir, createdAt: Date.now(), updatedAt: Date.now(), history });

  const loaded = loadSession(dir, id);
  check("session saved and loaded", !!loaded && loaded.history.length === 3);
  check("session title derived from first user message", loaded?.title === "build me a thing please");
  check("listSessions finds the session", listSessions(dir).some(s => s.id === id));
  check("session meta has message count", listSessions(dir).find(s => s.id === id)?.messageCount === 2);
  check("latestSession returns it", latestSession(dir)?.id === id);
  check("sessions are project-scoped (other dir is empty)", listSessions(join(dir, "nope")).length === 0);
  deleteSession(dir, id);
  check("deleteSession removes it", !listSessions(dir).some(s => s.id === id));

  // ─── Compaction history shape ──────────────────────────────────────────────
  const long: ChatCompletionMessageParam[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] } as any,
    { role: "tool", tool_call_id: "t1", content: "file contents" } as any,
    { role: "assistant", content: "a1-final" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ];
  const compacted = compactHistory(long, "SUMMARY TEXT", 2);
  check("compaction keeps the system message first", compacted[0]?.role === "system");
  check("compaction inserts a summary user message", typeof compacted[1]?.content === "string" && (compacted[1]!.content as string).includes("SUMMARY TEXT"));
  check("compaction tail starts on a user message (no orphan tool)",
    compacted[2]?.role === "user", compacted[2]?.role);
  check("compaction shrinks the history", compacted.length < long.length);

  // ─── Project context loading ───────────────────────────────────────────────
  check("no context file → findProjectContext null", findProjectContext(dir) === null);
  writeFileSync(join(dir, "LOCALCLI.md"), "# My Project\nThis is a test project.\nUse bun to run it.");
  const ctx = findProjectContext(dir);
  check("finds LOCALCLI.md", ctx?.file === "LOCALCLI.md");
  check("context content loaded", !!ctx && ctx.content.includes("test project"));
  saveConfig({ cwd: dir });
  const sp = systemPrompt({ mode: "normal" });
  check("system prompt injects project context", sp.includes("My Project") && sp.includes("Project context"));
  const spPlan = systemPrompt({ mode: "plan" });
  check("plan-mode system prompt has PLAN MODE section", spPlan.includes("PLAN MODE"));

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "FEATURES OK" : "FEATURES FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
