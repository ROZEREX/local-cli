// Tests for the Claude Code-style workflow features:
//   - set_todos (live session checklist): normalization, executor, aliases,
//     prompted-mode XML parsing
//   - propose_plan (plan → approve → build): XML parsing, and the full chat-loop
//     handshake — approval must flip planMode OFF mid-run so the model can
//     implement immediately in the same run
//   - sub-agent roles: "test:" / "fix:" prefixes parse to roles with the right
//     write access
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { executeTool } from "./src/tools/executor";
import { parseToolCalls } from "./src/toolparse";
import { normalizeTodos, getSessionTodos, clearSessionTodos, formatSessionTodos } from "./src/todos";
import { parseRoleTask } from "./src/agents";
import { noteUserTurn, noteToolOutcome, buildRuntimeOverride, isAwaitingScaffold, resetOrchestratorState } from "./src/orchestrator-state";
import { recommendContextWindow } from "./src/sysinfo";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${e}`)); };

// ─── normalizeTodos ───────────────────────────────────────────────────────────
console.log("normalizeTodos:");
{
  const fromObjects = normalizeTodos([
    { text: "read the code", status: "completed" },
    { content: "write the fix", status: "in-progress" },
    { task: "run tests", status: "PENDING" },
  ]);
  check("object items keep text + normalized status",
    fromObjects.length === 3 &&
    fromObjects[0]!.status === "completed" &&
    fromObjects[1]!.text === "write the fix" && fromObjects[1]!.status === "in_progress" &&
    fromObjects[2]!.status === "pending",
    JSON.stringify(fromObjects));

  const fromMarkers = normalizeTodos(["[x] done thing", "[>] current thing", "- [ ] next thing", "bare item"]);
  check("marker strings map to statuses",
    fromMarkers[0]!.status === "completed" && fromMarkers[1]!.status === "in_progress" &&
    fromMarkers[2]!.status === "pending" && fromMarkers[2]!.text === "next thing" &&
    fromMarkers[3]!.status === "pending",
    JSON.stringify(fromMarkers));

  const fromString = normalizeTodos("[x] a\n[ ] b");
  check("newline string body (prompted mode) parses", fromString.length === 2 && fromString[0]!.status === "completed");
}

// ─── set_todos through the executor (incl. aliases) ──────────────────────────
console.log("set_todos executor:");
{
  clearSessionTodos();
  const r1 = await executeTool("set_todos", { todos: [{ text: "step 1", status: "in_progress" }, { text: "step 2", status: "pending" }] });
  check("sets the session todos", getSessionTodos().length === 2 && /step 1/.test(r1), r1);
  check("result shows progress count", /0\/2 done/.test(r1), r1);

  const r2 = await executeTool("todo_write", { todos: [{ text: "step 1", status: "completed" }, { text: "step 2", status: "in_progress" }] });
  check("todo_write alias replaces the list", /1\/2 done/.test(r2) && getSessionTodos()[0]!.status === "completed", r2);

  const r3 = await executeTool("set_todos", {});
  check("missing todos → helpful error", /Error/.test(r3) && /todos/.test(r3), r3);
  check("formatSessionTodos renders the checklist", /☑ step 1/.test(formatSessionTodos()) && /▸ step 2/.test(formatSessionTodos()), formatSessionTodos());
  clearSessionTodos();
}

// ─── prompted-mode XML parsing ────────────────────────────────────────────────
console.log("prompted XML parsing:");
{
  const todoCalls = parseToolCalls("Working on it.\n<set_todos>\n[x] read files\n[>] make the change\n[ ] verify\n</set_todos>");
  check("<set_todos> body parses to one item per line",
    todoCalls.length === 1 && todoCalls[0]!.name === "set_todos" &&
    Array.isArray(todoCalls[0]!.arguments.todos) && todoCalls[0]!.arguments.todos.length === 3,
    JSON.stringify(todoCalls));

  const planCalls = parseToolCalls("<propose_plan>\n1. Create db.ts\n2. Wire routes\n</propose_plan>");
  check("<propose_plan> body becomes the plan arg",
    planCalls.length === 1 && planCalls[0]!.name === "propose_plan" &&
    /Create db\.ts/.test(planCalls[0]!.arguments.plan),
    JSON.stringify(planCalls));
}

// ─── sub-agent role prefixes ──────────────────────────────────────────────────
console.log("agent roles:");
{
  check("'test: run the suite' → test role", (() => { const p = parseRoleTask("test: run the suite"); return p.role === "test" && p.task === "run the suite"; })());
  check("'patch: fix login' aliases to fix role", parseRoleTask("patch: fix the login bug").role === "fix");
  check("'investigate:' aliases to explore role", parseRoleTask("investigate: where auth happens").role === "explore");
  check("unknown prefix stays part of the task", (() => { const p = parseRoleTask("frontend: is not a role"); return p.role === null && p.task === "frontend: is not a role"; })());
  check("no prefix → generic (null role)", parseRoleTask("look at the config").role === null);
}

// ─── system prompt stays prompt-sized ─────────────────────────────────────────
// Regression: a 187 KB behavior file (claude-fable-5.md) was once inlined into
// EVERY system prompt (~47k tokens), making every turn's prefill take minutes on
// every local model. The loader now size-guards substitutions; this asserts the
// whole prompt stays within an order of magnitude of sane.
console.log("system prompt size:");
{
  const { systemPrompt } = await import("./src/prompt");
  const sp = systemPrompt({ mode: "normal" });
  check(`system prompt stays prompt-sized (${Math.round(sp.length / 4)} tokens est.)`, sp.length < 80_000, `got ${sp.length} chars`);
  check("built-in behavior section present (giant file not inlined)", sp.includes("Refusal handling"));
}

// ─── orchestrator: green-field gate must not over-trigger ────────────────────
console.log("green-field detection:");
{
  const armsScaffold = (msg: string): boolean => {
    resetOrchestratorState();
    noteUserTurn(msg, true);
    return isAwaitingScaffold();
  };
  check("'build a todo app' arms the manifest gate", armsScaffold("build a todo app with dark mode"));
  check("'create an API for my shop' arms it", armsScaffold("create an API for my shop"));
  check("'start a new project from scratch' arms it", armsScaffold("start a new project from scratch"));
  check("'fix the build' does NOT arm it", !armsScaffold("fix the build, it fails on Windows"));
  check("'make the tests pass' does NOT arm it", !armsScaffold("make the tests pass"));
  check("'start the app' does NOT arm it", !armsScaffold("start the app and check the layout"));
  check("'create a function that sorts users' does NOT arm it", !armsScaffold("create a function that sorts users by name"));
  resetOrchestratorState();
}

// ─── orchestrator: verify-first escalation (hint at 1 strike, force at 2) ────
console.log("two-strike override:");
{
  resetOrchestratorState();
  noteUserTurn("the login is broken", true);
  check("ONE failure → gentle verify hint (not the hard ban)",
    /error_streak=1/.test(buildRuntimeOverride()) && !/BANNED/.test(buildRuntimeOverride()),
    buildRuntimeOverride());
  noteUserTurn("still broken, it fails", false);
  check("two failure reports arm the override", /Two-strike/.test(buildRuntimeOverride()));
  noteToolOutcome("search_via_chrome", { query: "docs" }, "Error searching via Chrome: no browser found");
  check("a FAILED search disarms it (no forced-tool deadlock)", buildRuntimeOverride() === "");
  noteUserTurn("nope, broken again", false);
  noteUserTurn("crash again", false);
  check("fresh failures re-arm it", /Two-strike/.test(buildRuntimeOverride()));
  noteToolOutcome("search_via_chrome", { query: "docs" }, "Live web results for \"docs\" …");
  check("a successful search also disarms it", buildRuntimeOverride() === "");
  resetOrchestratorState();
}

// ─── recommendContextWindow: the "what would actually fit fast" advisory ─────
// NOTE: the default context sync (syncContextForModel in App.tsx) now always
// adopts the model's FULL NATIVE MAX per the user's explicit preference — this
// function is no longer in that default path. It's kept as the estimate
// surfaced by modelFitWarning's "a window around Xk would keep it on the GPU"
// suggestion, for when the user opts to trade context for speed.
console.log("context window sizing (fit-warning advisory):");
{
  const NATIVE_256K = 262144;
  const gpu = (vramGB: number): any => ({
    os: "t", cpu: { model: "t", cores: 8 }, ramGB: 64, ramFreeGB: 32, gpus: [{ name: "GPU", vramGB }],
    budgetGB: vramGB, budgetSource: "gpu",
  });
  const cpuOnly: any = { os: "t", cpu: { model: "t", cores: 8 }, ramGB: 32, ramFreeGB: 16, gpus: [], budgetGB: 22, budgetSource: "ram" };

  // The reported bug: a 27B (~17 GB) model on a 24 GB card must NOT get 256k.
  const w24 = recommendContextWindow(17e9, NATIVE_256K, gpu(24));
  check("27B on 24GB does NOT balloon to the native max", w24 < NATIVE_256K && w24 <= 65536, `got ${w24}`);
  check("...and stays usable (>=8k)", w24 >= 8192, `got ${w24}`);

  // A tiny model on the same card can afford a bigger (but still bounded) window.
  check("a small 4GB model on 24GB gets more room than the big one",
    recommendContextWindow(4e9, NATIVE_256K, gpu(24)) > w24, `got ${recommendContextWindow(4e9, NATIVE_256K, gpu(24))} vs ${w24}`);

  // A model too big for the card → the smallest usable window.
  check("oversized model → smallest window", recommendContextWindow(30e9, NATIVE_256K, gpu(12)) === 8192, `got ${recommendContextWindow(30e9, NATIVE_256K, gpu(12))}`);

  // Never inflate past what the model itself supports.
  check("caps at native when native is small", recommendContextWindow(4e9, 8192, gpu(24)) === 8192);

  // Unknown weights / CPU-only → a safe mid default, never the giant max.
  check("unknown weights → 32k mid default", recommendContextWindow(undefined, NATIVE_256K, gpu(24)) === 32768);
  check("CPU-only → 32k mid default (no VRAM ceiling to blow)", recommendContextWindow(17e9, NATIVE_256K, cpuOnly) === 32768);
}

// ─── the plan → approve → build handshake through chat() ─────────────────────
console.log("propose_plan chat-loop handshake:");
const OUT_FILE = "test-tmp-plan-out.txt";
const outPath = join(process.cwd(), OUT_FILE);
if (existsSync(outPath)) unlinkSync(outPath);

let turn = 0;
const ndline = (o: any) => JSON.stringify(o) + "\n";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/api/version")) return Response.json({ version: "t" });
    if (p.endsWith("/api/tags")) return Response.json({ models: [{ name: "mock" }] });
    if (p.endsWith("/api/ps")) return Response.json({ models: [] });
    if (p.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
    if (p.endsWith("/api/chat")) {
      turn++;
      let body: string;
      if (turn === 1) {
        // Research done → the model proposes its plan.
        body =
          ndline({ message: { content: "", tool_calls: [{ function: { name: "propose_plan", arguments: { plan: "1. Step one: write the file\n2. Step two: verify" } } }] }, done: false }) +
          ndline({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 5, eval_duration: 1e9 });
      } else if (turn === 2) {
        // Approved → the model implements immediately (a write, which plan mode
        // would normally block).
        body =
          ndline({ message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: OUT_FILE, content: "plan implemented" } } }] }, done: false }) +
          ndline({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 5, eval_duration: 1e9 });
      } else {
        body =
          ndline({ message: { content: "Implemented the plan." }, done: false }) +
          ndline({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 5, eval_duration: 1e9 });
      }
      return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", thinking: false, cwd: process.cwd() });
resetClient();

let approvalCalls = 0;
let proposedPlan = "";
const toolResults: { name: string; result: string }[] = [];
const history: ChatCompletionMessageParam[] = [
  { role: "system", content: "s" },
  { role: "user", content: "plan and then build it" },
];

const hist = await chat(history, {
  onText: () => {},
  onToolCall: () => {},
  onToolResult: (name, result) => toolResults.push({ name, result }),
  onError: (e) => { check("no error during handshake", false, String(e)); },
  requestPermission: async () => true,
  requestPlanApproval: async (plan) => { approvalCalls++; proposedPlan = plan; return "approve"; },
}, { planMode: true });

check("requestPlanApproval fired exactly once with the plan", approvalCalls === 1 && /Step one/.test(proposedPlan), proposedPlan);
check("propose_plan result tells the model it was APPROVED",
  toolResults.some(r => r.name === "propose_plan" && /APPROVED/.test(r.result)),
  JSON.stringify(toolResults.map(r => r.name)));
check("write_file was NOT blocked by plan mode after approval",
  toolResults.some(r => r.name === "write_file" && !/\[plan mode\]/.test(r.result)),
  JSON.stringify(toolResults));
check("the implementation actually ran (file written)",
  existsSync(outPath) && readFileSync(outPath, "utf-8") === "plan implemented");
check("run finished with the final answer",
  hist.some(m => m.role === "assistant" && typeof m.content === "string" && m.content.includes("Implemented")));

if (existsSync(outPath)) unlinkSync(outPath);
server.stop(true);
console.log(`\n${fail === 0 ? "WORKFLOW-FEATURES OK" : "WORKFLOW-FEATURES FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
