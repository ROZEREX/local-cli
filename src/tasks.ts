import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { getConfig } from "./config";

// Lightweight per-project task list — a markdown checklist the agent (and the
// user, via /tasks) maintains in <project>/.local-cli/tasks.md. Open tasks are
// injected into the system prompt so long-running work survives new sessions:
// the agent can pick up where it left off.

export interface TaskItem {
  index: number;   // 1-based position in the file
  done: boolean;
  text: string;
}

export function tasksFilePath(): string {
  return join(getConfig().cwd, ".local-cli", "tasks.md");
}

export function readTasks(): TaskItem[] {
  const fp = tasksFilePath();
  if (!existsSync(fp)) return [];
  try {
    const lines = readFileSync(fp, "utf-8").split("\n");
    const items: TaskItem[] = [];
    for (const line of lines) {
      const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line);
      if (m) items.push({ index: items.length + 1, done: m[1] !== " ", text: m[2]!.trim() });
    }
    return items;
  } catch { return []; }
}

function writeTasks(items: TaskItem[]): void {
  const fp = tasksFilePath();
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = "# Tasks\n\n" + items.map(t => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n") + "\n";
  writeFileSync(fp, body, "utf-8");
}

export function addTask(text: string): TaskItem[] {
  const items = readTasks();
  const cleaned = text.trim();
  if (cleaned && !items.some(t => t.text.toLowerCase() === cleaned.toLowerCase())) {
    items.push({ index: items.length + 1, done: false, text: cleaned });
    writeTasks(items);
  }
  return readTasks();
}

// Mark a task done by 1-based index or by (case-insensitive) text match.
export function completeTask(ref: string | number): { ok: boolean; task?: TaskItem } {
  const items = readTasks();
  let target: TaskItem | undefined;
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) target = items[n - 1];
  if (!target && typeof ref === "string") {
    const needle = ref.toLowerCase();
    target = items.find(t => !t.done && t.text.toLowerCase().includes(needle)) ??
             items.find(t => t.text.toLowerCase().includes(needle));
  }
  if (!target) return { ok: false };
  target.done = true;
  writeTasks(items);
  return { ok: true, task: target };
}

export function removeDoneTasks(): number {
  const items = readTasks();
  const open = items.filter(t => !t.done);
  const removed = items.length - open.length;
  if (removed > 0) writeTasks(open);
  return removed;
}

export function clearTasks(): boolean {
  const fp = tasksFilePath();
  if (!existsSync(fp)) return false;
  try { unlinkSync(fp); return true; } catch { return false; }
}

export function describeTasks(): string {
  const items = readTasks();
  if (items.length === 0) return "No tasks yet. Add one with /tasks add <text> — the agent can also manage them with the task_add / task_done tools.";
  const open = items.filter(t => !t.done).length;
  return `Tasks (${open} open / ${items.length} total):\n` +
    items.map(t => `  ${t.done ? "☑" : "☐"} ${t.index}. ${t.text}`).join("\n");
}

// Section appended to the system prompt when there are open tasks.
export function tasksPromptSection(): string {
  const items = readTasks();
  const open = items.filter(t => !t.done);
  if (open.length === 0) return "";
  return `

# Project task list (persists across sessions — in .local-cli/tasks.md)
Open tasks:
${open.map(t => `- [ ] ${t.text}`).join("\n")}
When the user asks you to continue or asks what's pending, consult this list. Use task_done when you complete one, and task_add to record new multi-session work items. Don't mark tasks done that you haven't actually finished.`;
}
