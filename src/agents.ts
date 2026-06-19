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
  ok: boolean;
  output: string;
  toolCalls: number;
}

const MAX_AGENTS = 4;

function subAgentSystem(task: string, allowWrites: boolean): string {
  return systemPrompt({ mode: allowWrites ? "normal" : "plan" }) + `

# You are a SUB-AGENT
You were spawned to complete ONE focused task and report back. Your final text answer is returned to the agent (or user) that spawned you — make it a complete, self-contained report.
- Task: ${task}
- ${allowWrites
    ? "You MAY modify files if the task requires it. List every file you changed in your report."
    : "You are READ-ONLY: investigate with read_file / grep_files / glob_files / list_dir and report findings. Do not attempt to modify anything."}
- Do not ask questions — make reasonable assumptions and state them.
- Be thorough but conclude: end with a clear summary of findings/results.`;
}

export async function runSubAgent(
  task: string,
  opts: { allowWrites?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<SubAgentResult> {
  // Lazy import to avoid a hard circular dependency (llm → executor → agents).
  const { chat } = await import("./llm");
  const allowWrites = !!opts.allowWrites;
  let toolCalls = 0;
  let lastError = "";

  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: subAgentSystem(task, allowWrites) },
    { role: "user", content: task },
  ];

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
    return { task, ok: !!output && !lastError, output, toolCalls };
  } catch (e: any) {
    return { task, ok: false, output: `Sub-agent failed: ${e.message}`, toolCalls };
  }
}

export async function runSubAgents(
  tasks: string[],
  opts: { allowWrites?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<SubAgentResult[]> {
  const limited = tasks.filter(t => t.trim()).slice(0, MAX_AGENTS);
  // Concurrent — Ollama queues generations; each agent still gets its own
  // clean context. Writes are forced sequential to avoid two agents editing
  // the same file simultaneously.
  if (opts.allowWrites) {
    const out: SubAgentResult[] = [];
    for (const t of limited) out.push(await runSubAgent(t, opts));
    return out;
  }
  return Promise.all(limited.map(t => runSubAgent(t, opts)));
}

export function formatAgentResults(results: SubAgentResult[]): string {
  return results
    .map((r, i) =>
      `── Agent ${String.fromCharCode(65 + i)} (${r.toolCalls} tool calls${r.ok ? "" : ", FAILED"}) ──\nTask: ${r.task}\n\n${r.output}`
    )
    .join("\n\n") +
    `\n\n(${results.length} sub-agent${results.length === 1 ? "" : "s"} finished. Synthesize these reports for the user.)`;
}
