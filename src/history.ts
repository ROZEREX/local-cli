import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync, statSync } from "fs";
import { join, dirname, relative, resolve, isAbsolute } from "path";
import { getConfig } from "./config";

// Undo system. Every mutating file operation (write_file / edit_file /
// delete_file) records a snapshot patch in <project>/.local-cli/history/ so the
// user can roll back with /undo — which makes auto mode and bulk edits much less
// scary. Snapshots store the full before/after content (robust against partial
// or fuzzy applies, unlike textual patches) and are capped in count and size.

export interface HistoryEntry {
  seq: number;
  at: number;            // epoch ms
  op: "write" | "edit" | "delete" | "create";
  tool: string;          // tool that caused it
  path: string;          // relative to project cwd
  before: string | null; // null = file did not exist
  after: string | null;  // null = file was deleted
}

const MAX_ENTRIES = 200;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // skip recording absurdly large files

function historyDir(): string {
  return join(getConfig().cwd, ".local-cli", "history");
}

function entryFiles(): string[] {
  const dir = historyDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{6}\.json$/.test(f))
    .sort();
}

function readEntry(file: string): HistoryEntry | null {
  try { return JSON.parse(readFileSync(join(historyDir(), file), "utf-8")); }
  catch { return null; }
}

function nextSeq(): number {
  const files = entryFiles();
  if (files.length === 0) return 1;
  return Number(files[files.length - 1]!.slice(0, 6)) + 1;
}

// Record one file mutation. `before` = content prior to the change (null if the
// file didn't exist), `after` = content after (null if deleted). Best-effort:
// recording must never break the actual edit.
export function recordFileChange(
  tool: string,
  absPath: string,
  before: string | null,
  after: string | null
): void {
  try {
    if ((before?.length ?? 0) > MAX_SNAPSHOT_BYTES || (after?.length ?? 0) > MAX_SNAPSHOT_BYTES) return;
    if (before === after) return; // no-op
    const dir = historyDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const op: HistoryEntry["op"] =
      after === null ? "delete" : before === null ? "create" : tool === "write_file" ? "write" : "edit";
    const entry: HistoryEntry = {
      seq: nextSeq(),
      at: Date.now(),
      op,
      tool,
      path: relative(getConfig().cwd, absPath),
      before,
      after,
    };
    writeFileSync(join(dir, `${String(entry.seq).padStart(6, "0")}.json`), JSON.stringify(entry), "utf-8");
    // Cap total entries — drop the oldest beyond the limit.
    const files = entryFiles();
    for (let i = 0; i < files.length - MAX_ENTRIES; i++) {
      try { unlinkSync(join(dir, files[i]!)); } catch {}
    }
  } catch {
    /* never block the actual edit */
  }
}

export function listHistory(limit = 20): HistoryEntry[] {
  const files = entryFiles();
  return files.slice(-limit).map(readEntry).filter((e): e is HistoryEntry => !!e);
}

export function historyCount(): number {
  return entryFiles().length;
}

// Revert the most recent `n` changes (newest first). A reverted entry is
// consumed (removed from history). Returns a human-readable report.
export function undoLast(n = 1): string {
  const files = entryFiles();
  if (files.length === 0) return "Nothing to undo — no recorded file changes.";
  const cwd = getConfig().cwd;
  const lines: string[] = [];
  let undone = 0;

  for (let i = 0; i < n && files.length - 1 - i >= 0; i++) {
    const file = files[files.length - 1 - i]!;
    const entry = readEntry(file);
    if (!entry) { try { unlinkSync(join(historyDir(), file)); } catch {} continue; }
    const abs = isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path);
    try {
      // Safety: if the file changed since we recorded `after`, warn but still
      // restore `before` (the user explicitly asked to undo).
      let drifted = false;
      if (entry.after !== null && existsSync(abs)) {
        try { drifted = readFileSync(abs, "utf-8") !== entry.after; } catch {}
      }
      if (entry.before === null) {
        // The change created the file → undo = delete it.
        if (existsSync(abs)) unlinkSync(abs);
        lines.push(`↩ removed ${entry.path} (was created by ${entry.tool})${drifted ? " — note: it had been modified since" : ""}`);
      } else {
        const dir = dirname(abs);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(abs, entry.before, "utf-8");
        lines.push(`↩ restored ${entry.path} (${entry.op} by ${entry.tool})${drifted ? " — note: it had been modified since" : ""}`);
      }
      unlinkSync(join(historyDir(), file));
      undone++;
    } catch (e: any) {
      lines.push(`✘ could not undo ${entry.path}: ${e.message}`);
    }
  }

  if (undone === 0 && lines.length === 0) return "Nothing to undo.";
  const left = historyCount();
  return lines.join("\n") + `\n${undone} change${undone === 1 ? "" : "s"} undone. ${left} more in history.`;
}

// Pretty list for /undo list.
export function describeHistory(limit = 15): string {
  const entries = listHistory(limit);
  if (entries.length === 0) return "No recorded file changes yet. Mutations made via write_file / edit_file / delete_file are recorded automatically.";
  const total = historyCount();
  const fmt = (e: HistoryEntry) => {
    const t = new Date(e.at);
    const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return `  #${e.seq}  ${hh}  ${e.op.padEnd(6)} ${e.path}`;
  };
  return `File change history (${total} total, newest last):\n` + entries.map(fmt).join("\n") +
    "\n\nUndo the most recent with /undo, or several with /undo <n>.";
}
