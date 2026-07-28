import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { systemPrompt } from "./prompt";

// Multi-agent mode: spawn headless sub-agents that each work on ONE focused
// task with their own fresh context, then return their final answers to the
// caller (the main agent, via the spawn_agents tool, or the user via /agents).
// Read-only by default — a sub-agent investigates/reviews; only when
// allow_writes is set can it modify files. They run concurrently; a local
// Ollama serializes the actual generations, so this mostly saves context, not
// wall-clock time — the win is that each agent gets a CLEAN window for its task.

export interface SubAgentResult {
  task: string;
  role: AgentRole | null;
  ok: boolean;
  output: string;
  toolCalls: number;
}

const MAX_AGENTS = 4;

// Specialized roles (Claude Code-style agent types). A task opts into one with a
// "role:" prefix — e.g. "test: run the suite", "fix: the login 500". Roles that
// must execute or change things get write access implicitly; the rest stay
// read-only. Unprefixed tasks remain generic read-only investigators.
export type AgentRole = "explore" | "plan" | "review" | "test" | "code" | "fix";

const ROLES: Record<AgentRole, { writes: boolean; prompt: string }> = {
  explore: {
    writes: false,
    prompt: "ROLE: EXPLORER. Map the relevant code thoroughly — directory layout, entry points, the modules involved in the task. Report concrete findings with file:line references, not vague descriptions.",
  },
  plan: {
    writes: false,
    prompt: "ROLE: PLANNER. Research the code, then produce a step-by-step implementation plan: numbered steps, the exact files to change and how, risks, and how to verify. Do not write any code changes.",
  },
  review: {
    writes: false,
    prompt: "ROLE: REVIEWER. Review the code named in the task like a senior engineer: bugs and logic errors, security issues, regressions, then quality improvements — each with file:line and a concrete suggestion, ordered by severity. End with a clear verdict.",
  },
  test: {
    writes: true,
    prompt: "ROLE: TESTER. Find and RUN the relevant tests/build (bash; package.json or the stack's manifest tells you the command). Report exactly what passed and what failed with the real output quoted. Do not modify source files unless the task explicitly says to fix them.",
  },
  code: {
    writes: true,
    prompt: "ROLE: CODER. Implement exactly what the task describes — read the surrounding code first, make the changes with edit_file/write_file, and verify (build/test) when possible. List every file you changed and what you did in your report.",
  },
  fix: {
    writes: true,
    prompt: "ROLE: FIXER. Reproduce or locate the failure first (run the failing command/test, read the error), state the root cause with evidence, make the smallest correct fix, then RE-RUN to prove it's fixed. Report cause → fix → verification.",
  },
};

// "test: run the suite" → { role: "test", task: "run the suite" }. Case-insensitive;
// anything that isn't a known role is left as part of the task text.
export function parseRoleTask(raw: string): { role: AgentRole | null; task: string } {
  const m = /^\s*([a-zA-Z]+)\s*:\s*(.+)$/s.exec(raw);
  if (m) {
    const role = m[1]!.toLowerCase();
    if (role in ROLES) return { role: role as AgentRole, task: m[2]!.trim() };
    if (role === "investigate") return { role: "explore", task: m[2]!.trim() };
    if (role === "patch") return { role: "fix", task: m[2]!.trim() };
  }
  return { role: null, task: raw.trim() };
}

function subAgentSystem(task: string, allowWrites: boolean, role: AgentRole | null): string {
  return systemPrompt({ mode: allowWrites ? "normal" : "plan" }) + `

# You are a SUB-AGENT
You were spawned to complete ONE focused task and report back. Your final text answer is returned to the agent (or user) that spawned you — make it a complete, self-contained report.
- Task: ${task}
- ${allowWrites
    ? "You MAY modify files if the task requires it. List every file you changed in your report."
    : "You are READ-ONLY: investigate with read_file / grep_files / glob_files / list_dir and report findings. Do not attempt to modify anything."}
- Do not ask questions — make reasonable assumptions and state them.
- Be thorough but conclude: end with a clear summary of findings/results.${role ? `\n- ${ROLES[role].prompt}` : ""}`;
}

// Nesting guard: sub-agents run headless with auto-accepted tools, so one
// spawning further sub-agents would recurse unbounded (each generation queueing
// more generations on the same local model). Depth is capped at 1.
let activeSubAgents = 0;
export function inSubAgent(): boolean { return activeSubAgents > 0; }

export async function runSubAgent(
  task: string,
  opts: { allowWrites?: boolean; role?: AgentRole | null; onProgress?: (msg: string) => void } = {}
): Promise<SubAgentResult> {
  // Lazy import to avoid a hard circular dependency (llm → executor → agents).
  const { chat } = await import("./llm");
  const parsed = opts.role !== undefined ? { role: opts.role, task } : parseRoleTask(task);
  const role = parsed.role;
  task = parsed.task;
  // A role that must execute or modify things implies write access; an explicit
  // allow_writes from the spawner also grants it to every task.
  const allowWrites = !!opts.allowWrites || (role ? ROLES[role].writes : false);
  let toolCalls = 0;
  let lastError = "";

  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: subAgentSystem(task, allowWrites, role) },
    { role: "user", content: task },
  ];

  activeSubAgents++;
  try {
    const result = await chat(
      history,
      {
        onText: () => {},
        onToolCall: (name) => { toolCalls++; opts.onProgress?.(`sub-agent tool: ${name}`); },
        onToolResult: () => {},
        onError: (e) => { lastError = e.message; },
        // Headless: no permission UI — plan mode already blocks writes unless
        // allow_writes was granted, in which case the spawner approved them.
      },
      { planMode: !allowWrites, autoAccept: allowWrites }
    );
    // The report = the last assistant message with content.
    let output = "";
    for (let i = result.length - 1; i >= 0; i--) {
      const m = result[i]!;
      if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
        output = m.content.trim();
        break;
      }
    }
    if (!output) output = lastError ? `(no report — error: ${lastError})` : "(the sub-agent produced no final report)";
    return { task, role, ok: !!output && !lastError, output, toolCalls };
  } catch (e: any) {
    return { task, role, ok: false, output: `Sub-agent failed: ${e.message}`, toolCalls };
  } finally {
    activeSubAgents--;
  }
}

export async function runSubAgents(
  tasks: string[],
  opts: { allowWrites?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<SubAgentResult[]> {
  const limited = tasks.filter(t => t.trim()).slice(0, MAX_AGENTS);
  // Concurrent — Ollama queues generations; each agent still gets its own
  // clean context. Writes are forced sequential to avoid two agents editing
  // the same file simultaneously — including role-implied writes (test/code/fix).
  const anyWrites = !!opts.allowWrites ||
    limited.some(t => { const r = parseRoleTask(t).role; return r ? ROLES[r].writes : false; });
  if (anyWrites) {
    const out: SubAgentResult[] = [];
    for (const t of limited) out.push(await runSubAgent(t, opts));
    return out;
  }
  return Promise.all(limited.map(t => runSubAgent(t, opts)));
}

export function formatAgentResults(results: SubAgentResult[]): string {
  return results
    .map((r, i) =>
      `── Agent ${String.fromCharCode(65 + i)}${r.role ? ` [${r.role}]` : ""} (${r.toolCalls} tool calls${r.ok ? "" : ", FAILED"}) ──\nTask: ${r.task}\n\n${r.output}`
    )
    .join("\n\n") +
    `\n\n(${results.length} sub-agent${results.length === 1 ? "" : "s"} finished. Synthesize these reports for the user.)`;
}
