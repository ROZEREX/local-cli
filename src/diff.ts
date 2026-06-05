// Minimal LCS line diff for the permission preview — shows what an edit_file or
// write_file will actually change before the user approves it.

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length, n = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: "ctx", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: "del", text: a[i]! }); i++; }
    else { out.push({ type: "add", text: b[j]! }); j++; }
  }
  while (i < m) out.push({ type: "del", text: a[i++]! });
  while (j < n) out.push({ type: "add", text: b[j++]! });
  return out;
}

// Collapse long runs of unchanged context to keep the preview compact.
export function compactDiff(
  lines: DiffLine[],
  context = 2,
  maxLines = 30
): { lines: DiffLine[]; truncated: number } {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== "ctx") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap) { out.push({ type: "ctx", text: "⋯" }); gap = false; }
      out.push(lines[i]!);
    } else {
      gap = true;
    }
  }

  if (out.length > maxLines) return { lines: out.slice(0, maxLines), truncated: out.length - maxLines };
  return { lines: out, truncated: 0 };
}

export interface DiffView { lines: DiffLine[]; truncated: number; added: number; removed: number; }

export function buildDiffView(oldText: string, newText: string): DiffView {
  const full = lineDiff(oldText, newText);
  const added = full.filter(l => l.type === "add").length;
  const removed = full.filter(l => l.type === "del").length;
  const { lines, truncated } = compactDiff(full);
  return { lines, truncated, added, removed };
}
