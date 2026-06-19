import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { getConfig } from "./config";

// Per-project agent memory: durable facts about THIS project that the agent
// learns across sessions ("backend uses NestJS", "never touch migrations by
// hand"). Stored as plain markdown in <project>/.local-cli/memory.md, injected
// into the system prompt, and maintained by the agent itself via the
// remember/recall tools. Complements the coding profile (cross-project style)
// and LOCALCLI.md (project docs): memory is for learned facts and decisions.

const MAX_MEMORY_CHARS = 8000;

export function memoryFilePath(): string {
  return join(getConfig().cwd, ".local-cli", "memory.md");
}

export function readMemory(): string {
  const fp = memoryFilePath();
  if (!existsSync(fp)) return "";
  try { return readFileSync(fp, "utf-8").trim(); } catch { return ""; }
}

// Append one or more facts (markdown bullets). Dedupes exact lines.
export function addMemory(content: string): { added: number; skipped: number } {
  const fp = memoryFilePath();
  const existing = readMemory();
  const existingLines = new Set(existing.split("\n").map(l => l.trim()).filter(Boolean));
  const newLines = content
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (l.startsWith("-") || l.startsWith("*") || l.startsWith("#") ? l : `- ${l}`));

  let added = 0, skipped = 0;
  const toAdd: string[] = [];
  for (const l of newLines) {
    if (existingLines.has(l)) { skipped++; continue; }
    toAdd.push(l);
    existingLines.add(l);
    added++;
  }
  if (added > 0) {
    const dir = dirname(fp);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let next = (existing ? existing + "\n" : "") + toAdd.join("\n") + "\n";
    // Keep memory bounded — drop oldest lines beyond the cap.
    if (next.length > MAX_MEMORY_CHARS) {
      const lines = next.split("\n");
      while (lines.length > 1 && lines.join("\n").length > MAX_MEMORY_CHARS) lines.shift();
      next = lines.join("\n");
    }
    writeFileSync(fp, next, "utf-8");
  }
  return { added, skipped };
}

// Remove memory lines containing the given text (case-insensitive).
export function forgetMemory(match: string): number {
  const existing = readMemory();
  if (!existing) return 0;
  const needle = match.toLowerCase();
  const lines = existing.split("\n");
  const kept = lines.filter(l => !l.toLowerCase().includes(needle));
  const removed = lines.length - kept.length;
  if (removed > 0) writeFileSync(memoryFilePath(), kept.join("\n").trim() + "\n", "utf-8");
  return removed;
}

export function clearMemory(): boolean {
  const fp = memoryFilePath();
  if (!existsSync(fp)) return false;
  try { unlinkSync(fp); return true; } catch { return false; }
}

// Section appended to the system prompt when memory exists.
export function memoryPromptSection(): string {
  const mem = readMemory();
  if (!mem) return "";
  return `

# Project memory (facts you learned about THIS project in past sessions — trust and apply them)
${mem}
Keep this memory current: when you learn a new durable fact about this project (architecture decisions, gotchas, things never to touch), save it with the remember tool. Don't re-ask things already answered here.`;
}
