// Session todo list — the agent's LIVE working checklist for the current
// multi-step task (the set_todos tool). Unlike tasks.ts (persistent, on disk,
// survives sessions), this is deliberately in-memory and per-conversation: it
// shows the user what the agent is doing RIGHT NOW and is thrown away on /new.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface SessionTodo {
  text: string;
  status: TodoStatus;
}

let todos: SessionTodo[] = [];

export function setSessionTodos(items: SessionTodo[]): void {
  todos = items.filter(t => t.text.trim());
}

export function getSessionTodos(): SessionTodo[] {
  return todos;
}

export function clearSessionTodos(): void {
  todos = [];
}

// Normalize the many shapes models send into SessionTodo[]:
//   - [{ text, status }] (the documented schema; content/task/title accepted)
//   - ["[x] done thing", "[>] current thing", "[ ] next thing"] (marker strings)
//   - "one item\nper line" (prompted mode sends the tag body as a string)
export function normalizeTodos(input: any): SessionTodo[] {
  const items: any[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split("\n").map(s => s.trim()).filter(Boolean)
      : [];
  const out: SessionTodo[] = [];
  for (const it of items) {
    if (it && typeof it === "object") {
      const text = String(it.text ?? it.content ?? it.task ?? it.title ?? "").trim();
      if (!text) continue;
      out.push({ text, status: normalizeStatus(String(it.status ?? it.state ?? "pending")) });
      continue;
    }
    const s = String(it).trim();
    if (!s) continue;
    const m = /^[-*]?\s*\[([ xX>~oO.])\]\s*(.+)$/.exec(s);
    if (m) {
      const mark = m[1]!.toLowerCase();
      out.push({
        text: m[2]!.trim(),
        status: mark === "x" ? "completed" : mark === " " ? "pending" : "in_progress",
      });
    } else {
      out.push({ text: s, status: "pending" });
    }
  }
  return out;
}

function normalizeStatus(s: string): TodoStatus {
  const v = s.toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "completed" || v === "complete" || v === "done" || v === "finished") return "completed";
  if (v === "in_progress" || v === "active" || v === "current" || v === "doing" || v === "started") return "in_progress";
  return "pending";
}

const MARK: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▸",
  completed: "☑",
};

export function formatSessionTodos(): string {
  if (todos.length === 0) return "No session todos. The agent creates them with set_todos while working on a multi-step task.";
  const done = todos.filter(t => t.status === "completed").length;
  return `Todos (${done}/${todos.length} done):\n` +
    todos.map(t => `  ${MARK[t.status]} ${t.text}`).join("\n");
}
