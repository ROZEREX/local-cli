import "./test-config-setup";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveConfig, configDir } from "./src/config";
import { chat, resetClient, type ToolCallMeta } from "./src/llm";
import { TOOL_DEFINITIONS } from "./src/tools/definitions";
import { executeTool, resolveWorkspacePath } from "./src/tools/executor";
import { isClassifiedTool, isParallelSafeTool, requiresToolPermission } from "./src/tools/policy";
import { deleteSession, isValidSessionId, listSessions, loadSession, saveSession, type Session } from "./src/session";

let pass = 0, fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

const base = mkdtempSync(join(tmpdir(), "lcli-hardening-"));
const workspace = join(base, "project");
const sibling = join(base, "project-escape");
mkdirSync(workspace);
mkdirSync(sibling);
writeFileSync(join(workspace, "inside.txt"), "inside");
writeFileSync(join(sibling, "secret.txt"), "outside");

saveConfig({ cwd: workspace, alwaysAllow: [], mode: "normal", toolMode: "native", provider: "openai" });

// ── Workspace boundary ──────────────────────────────────────────────────────
check("workspace root resolves", resolveWorkspacePath(".") === workspace);
check("valid file remains readable", (await executeTool("read_file", { path: "inside.txt" })).includes("inside"));
check("list_dir without a path still lists cwd", (await executeTool("list_dir", {})).includes("inside.txt"));

const traversal = await executeTool("read_file", { path: "../project-escape/secret.txt" });
check("../ traversal is rejected", traversal.includes("outside the workspace"), traversal);
const absoluteEscape = await executeTool("read_file", { path: join(sibling, "secret.txt") });
check("absolute outside path is rejected", absoluteEscape.includes("outside the workspace"), absoluteEscape);
let siblingPrefixRejected = false;
try { resolveWorkspacePath(join(sibling, "secret.txt")); } catch { siblingPrefixRejected = true; }
check("sibling-prefix path is not mistaken for a child", siblingPrefixRejected);
check("glob traversal is rejected before evaluation", (await executeTool("glob_files", { pattern: "../**/*" })).includes("outside the workspace"));
check("bash cwd cannot escape workspace", (await executeTool("bash", { command: "echo should-not-run", cwd: sibling })).includes("outside the workspace"));
check("valid nested writes still work", (await executeTool("write_file", { path: "nested/ok.txt", content: "ok" })).includes("Written") && readFileSync(join(workspace, "nested", "ok.txt"), "utf-8") === "ok");
try {
  symlinkSync(sibling, join(workspace, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  const symlinkEscape = await executeTool("read_file", { path: "outside-link/secret.txt" });
  check("in-workspace symlink cannot tunnel outside", symlinkEscape.includes("through a symlink"), symlinkEscape);
} catch (e: any) {
  console.log(`  - symlink containment test skipped (${e.message})`);
}

// ── Session filename/path hardening ─────────────────────────────────────────
const session: Session = {
  id: "2026-08-26T12-00-00-000Z",
  title: "secure session",
  model: "mock",
  cwd: workspace,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  history: [{ role: "user", content: "hello" }],
};
saveSession(session);
check("generated-style session id is valid", isValidSessionId(session.id));
check("valid session round-trips", loadSession(workspace, session.id)?.title === session.title);
check("traversal session id is invalid", !isValidSessionId("../../config"));
check("traversal load is rejected", loadSession(workspace, "../../config") === null);
check("traversal delete is rejected", deleteSession(workspace, "../../config") === false);
let invalidSaveThrew = false;
try { saveSession({ ...session, id: "../escape" }); } catch { invalidSaveThrew = true; }
check("invalid session id cannot be saved", invalidSaveThrew);

// A valid filename with forged JSON metadata must not cross project/session
// identity boundaries when listed or loaded.
const key = createHash("sha1").update(workspace.toLowerCase()).digest("hex").slice(0, 12);
const sessionDir = join(configDir(), "sessions", key);
writeFileSync(join(sessionDir, "spoof.json"), JSON.stringify({ ...session, id: "../escape" }));
check("list ignores forged session metadata", !listSessions(workspace).some(s => s.id === "../escape"));
check("load ignores id/filename mismatch", loadSession(workspace, "spoof") === null);
check("valid session can still be deleted", deleteSession(workspace, session.id) && loadSession(workspace, session.id) === null);

// ── Centralized fail-closed policy ──────────────────────────────────────────
const definitionNames = TOOL_DEFINITIONS.flatMap(d => "function" in d ? [d.function.name] : []);
check("every declared tool has an explicit policy", definitionNames.every(isClassifiedTool), definitionNames.filter(n => !isClassifiedTool(n)).join(", "));
check("unknown future tools fail closed", requiresToolPermission("future_side_effect"));
for (const name of ["remember", "task_add", "task_done", "index_workspace", "browser_close", "browser_scroll", "page_find", "page_highlight", "page_scroll", "search_via_chrome"]) {
  check(`${name} requires approval`, requiresToolPermission(name));
}
check("ordinary reads remain approval-free", ["read_file", "glob_files", "grep_files", "list_dir", "recall"].every(n => !requiresToolPermission(n)));
check("shared browser reads are sequential", !isParallelSafeTool("browser_read"));

// ── End-to-end approval IDs, fail-closed behavior, and lifecycle timing ─────
function sse(value: any): string { return `data: ${JSON.stringify(value)}\n\n`; }
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/api/version")) return new Response("not ollama", { status: 404 });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 });
    const body: any = await req.json();
    const hasToolResult = body.messages?.some((m: any) => m.role === "tool");
    const stream = new ReadableStream({
      start(controller) {
        const enc = (s: string) => controller.enqueue(new TextEncoder().encode(s));
        if (!hasToolResult) {
          enc(sse({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_secure", type: "function", function: { name: "write_file", arguments: '{"path":"approval.txt","content":"approved"}' } }] }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
        } else {
          enc(sse({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] }));
          enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        }
        enc("data: [DONE]\n\n");
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});

saveConfig({ cwd: workspace, baseUrl: `http://localhost:${server.port}/v1`, apiKey: "test", model: "mock", provider: "openai", toolMode: "native", alwaysAllow: [] });

async function runApproval(permission?: (name: string, args: any, meta?: ToolCallMeta) => Promise<any>) {
  resetClient();
  const events: { kind: "start" | "result"; meta?: ToolCallMeta; result?: string }[] = [];
  await chat(
    [{ role: "system", content: "test" }, { role: "user", content: "write it" }],
    {
      onText: () => {},
      onToolCall: (_name, _args, meta) => events.push({ kind: "start", meta }),
      onToolResult: (_name, result, meta) => events.push({ kind: "result", result, meta }),
      onError: e => { throw e; },
      ...(permission ? { requestPermission: permission } : {}),
    }
  );
  return events;
}

rmSync(join(workspace, "approval.txt"), { force: true });
const noHandlerEvents = await runApproval();
check("mutating call without a permission handler is denied", !existsSync(join(workspace, "approval.txt")) && noHandlerEvents.some(e => e.meta?.phase === "denied"));

const staleEvents = await runApproval(async () => ({ callId: "old_call" }));
check("stale approval id is rejected", !existsSync(join(workspace, "approval.txt")) && staleEvents.some(e => e.result?.includes("mismatched")));

let seenPermissionId = "";
const approvedEvents = await runApproval(async (_name, _args, meta) => {
  seenPermissionId = meta?.callId ?? "";
  return { callId: seenPermissionId };
});
const start = approvedEvents.find(e => e.kind === "start")?.meta;
const result = approvedEvents.find(e => e.kind === "result")?.meta;
check("matching approval id permits execution", existsSync(join(workspace, "approval.txt")) && seenPermissionId === "call_secure");
check("tool start precedes its result", approvedEvents.findIndex(e => e.kind === "start") < approvedEvents.findIndex(e => e.kind === "result"));
check("start/result share a stable call id", !!start?.callId && start.callId === result?.callId);
check("completed event carries duration", result?.phase === "completed" && typeof result.durationMs === "number" && result.durationMs >= 0);

server.stop(true);
rmSync(base, { recursive: true, force: true });
rmSync(sessionDir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "CORE HARDENING OK" : "CORE HARDENING FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
