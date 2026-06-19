import { lineDiff, type DiffLine } from "./diff";

// Hunk model for interactive diff approval: a hunk is a contiguous run of
// added/removed lines (with the unchanged lines between hunks as separators).
// The user can toggle individual hunks in the permission prompt ([s] select
// hunks) and apply only some of them — we rebuild the resulting text by
// keeping the original lines for rejected hunks.

export interface Hunk {
  index: number;
  lines: DiffLine[];     // only add/del lines of this hunk
  // Short header for the UI: first changed line, truncated.
  header: string;
  added: number;
  removed: number;
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const diff = lineDiff(oldText, newText);
  const hunks: Hunk[] = [];
  let current: DiffLine[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current.find(l => l.text.trim().length > 0) ?? current[0]!;
    hunks.push({
      index: hunks.length,
      lines: current,
      header: first.text.trim().slice(0, 60) || "(blank lines)",
      added: current.filter(l => l.type === "add").length,
      removed: current.filter(l => l.type === "del").length,
    });
    current = [];
  };
  for (const l of diff) {
    if (l.type === "ctx") flush();
    else current.push(l);
  }
  flush();
  return hunks;
}

// Rebuild the "new" text applying only the selected hunks; rejected hunks keep
// the original lines. `selected` holds hunk indexes to APPLY.
export function applyHunks(oldText: string, newText: string, selected: Set<number>): string {
  const diff = lineDiff(oldText, newText);
  const out: string[] = [];
  let hunkIdx = -1;
  let inHunk = false;
  for (const l of diff) {
    if (l.type === "ctx") {
      inHunk = false;
      out.push(l.text);
      continue;
    }
    if (!inHunk) { hunkIdx++; inHunk = true; }
    const apply = selected.has(hunkIdx);
    if (l.type === "add" && apply) out.push(l.text);
    if (l.type === "del" && !apply) out.push(l.text);
  }
  return out.join("\n");
}
