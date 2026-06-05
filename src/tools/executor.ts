import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import { glob } from "glob";
import { spawnSync } from "child_process";
import { getConfig } from "../config";

function resolvePath(p: string): string {
  if (!p) return getConfig().cwd;
  return resolve(getConfig().cwd, p);
}

// ─── read_file ────────────────────────────────────────────────────────────────
export function readFile(args: { path: string; offset?: number; limit?: number }): string {
  if (!args.path) return "Error: path is required.";
  const fp = resolvePath(args.path);
  if (!existsSync(fp)) return `Error: File not found: ${fp}`;
  if (statSync(fp).isDirectory()) return `Error: Path is a directory, not a file: ${fp}`;
  try {
    const lines = readFileSync(fp, "utf-8").split("\n");
    const start = args.offset ? Math.max(0, args.offset - 1) : 0;
    const end = args.limit ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}\t${l}`)
      .join("\n");
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
}

// ─── write_file ───────────────────────────────────────────────────────────────
export function writeFile(args: { path: string; content: string }): string {
  if (!args.path) return "Error: path is required.";
  const fp = resolvePath(args.path);
  if (existsSync(fp) && statSync(fp).isDirectory()) {
    return `Error: Path is a directory, not a file: ${fp}`;
  }
  if (args.content === undefined || args.content === null) {
    return `Error: content was not provided or could not be parsed. Please place the content between <write_file>...</write_file> tags.`;
  }
  try {
    const dir = dirname(fp);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fp, args.content, "utf-8");
    return `Written ${args.content.length} chars to ${relative(getConfig().cwd, fp)}`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}

// If most lines look like read_file's "<n>\t…" gutter (the model copied the
// search text straight out of read output), strip it.
function stripGutter(s: string): string {
  const lines = s.split("\n");
  const gut = lines.filter(l => /^\s*\d+\t/.test(l)).length;
  if (gut >= Math.max(1, Math.ceil(lines.length * 0.6))) {
    return lines.map(l => l.replace(/^\s*\d+\t/, "")).join("\n");
  }
  return s;
}

// Whitespace-tolerant, line-based match+replace. Tries progressively looser
// line equality (exact → trailing-ws → trimmed → collapsed) and only replaces
// when the match is unique (unless replaceAll). Operates on \n-normalized text.
function fuzzyReplaceLines(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean
): { updated: string; count: number } | { error: string } {
  const fileLines = content.split("\n");
  const searchLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const norms: ((l: string) => string)[] = [
    l => l,
    l => l.replace(/\s+$/, ""),
    l => l.trim(),
    l => l.replace(/\s+/g, " ").trim(),
  ];
  for (const norm of norms) {
    const fn = fileLines.map(norm);
    const sn = searchLines.map(norm);
    const starts: number[] = [];
    for (let i = 0; i + sn.length <= fn.length; i++) {
      let ok = true;
      for (let j = 0; j < sn.length; j++) if (fn[i + j] !== sn[j]) { ok = false; break; }
      if (ok) starts.push(i);
    }
    if (starts.length === 0) continue;
    if (starts.length > 1 && !replaceAll) {
      return { error: `old_string matches ${starts.length} locations. Add more surrounding context to make it unique, or set replace_all.` };
    }
    const targets = (replaceAll ? starts : [starts[0]!]).sort((a, b) => b - a);
    const result = fileLines.slice();
    for (const start of targets) result.splice(start, sn.length, ...newLines);
    return { updated: result.join("\n"), count: targets.length };
  }
  return { error: "" };
}

// ─── edit_file ────────────────────────────────────────────────────────────────
export function editFile(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): string {
  if (!args.path) return "Error: edit_file needs a 'path' (the file to change). Call it again with path, old_string (exact text to find), and new_string.";
  const fp = resolvePath(args.path);
  if (!existsSync(fp)) return `Error: File not found: ${fp}`;
  if (statSync(fp).isDirectory()) return `Error: Path is a directory, not a file: ${fp}`;
  if (args.old_string === undefined || args.old_string === null) {
    return `Error: old_string (search block) was not provided. Put the text to find between <search>...</search> tags.`;
  }
  if (args.new_string === undefined || args.new_string === null) {
    return `Error: new_string (replace block) was not provided. Put the replacement between <replace>...</replace> tags.`;
  }
  try {
    const raw = readFileSync(fp, "utf-8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const content = raw.replace(/\r\n/g, "\n");
    const oldStr = stripGutter(args.old_string).replace(/\r\n/g, "\n");
    const newStr = args.new_string.replace(/\r\n/g, "\n");
    if (!oldStr.trim()) return "Error: old_string (search) is empty.";
    const rel = relative(getConfig().cwd, fp);
    const write = (text: string) => writeFileSync(fp, text.replace(/\n/g, eol), "utf-8");

    // 1. Exact substring match (handles partial-line edits).
    const occ = content.split(oldStr).length - 1;
    if (occ > 0) {
      if (occ > 1 && !args.replace_all) {
        return `Error: old_string matches ${occ} locations. Add more context to make it unique, or set replace_all.`;
      }
      write(args.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr));
      return `Edited ${rel} (replaced ${args.replace_all ? occ : 1} occurrence${occ > 1 && args.replace_all ? "s" : ""})`;
    }

    // 2. Whitespace-tolerant line match (handles indentation/trailing-ws/CRLF drift).
    const res = fuzzyReplaceLines(content, oldStr, newStr, !!args.replace_all);
    if ("error" in res) {
      return res.error
        ? `Error: ${res.error}`
        : `Error: old_string not found in ${args.path}. Read the file again and copy the exact text (including indentation) to replace.`;
    }
    write(res.updated);
    return `Edited ${rel} (replaced ${res.count} occurrence${res.count > 1 ? "s" : ""}, whitespace-tolerant match)`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}

// ─── glob_files ───────────────────────────────────────────────────────────────
export async function globFiles(args: { pattern: string; cwd?: string }): Promise<string> {
  const cwd = args.cwd ? resolvePath(args.cwd) : getConfig().cwd;
  try {
    const matches = await glob(args.pattern, { cwd, nodir: false });
    if (matches.length === 0) return "No files matched.";
    return matches.sort().join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ─── grep_files ───────────────────────────────────────────────────────────────
export async function grepFiles(args: {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  context?: number;
}): Promise<string> {
  const searchPath = args.path ? resolvePath(args.path) : getConfig().cwd;
  const flags = args.case_insensitive ? "gi" : "g";
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, flags);
  } catch {
    return `Error: Invalid regex: ${args.pattern}`;
  }

  let files: string[] = [];
  const isFile = existsSync(searchPath) && statSync(searchPath).isFile();

  if (isFile) {
    files = [searchPath];
  } else {
    const pattern = args.glob || "**/*";
    files = (await glob(pattern, { cwd: searchPath, nodir: true, absolute: true }));
  }

  const results: string[] = [];
  const ctx = args.context ?? 0;

  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    const lines = content.split("\n");
    const matched: number[] = [];
    lines.forEach((line, i) => { if (re.test(line)) matched.push(i); re.lastIndex = 0; });
    if (matched.length === 0) continue;

    const shown = new Set<number>();
    matched.forEach(i => {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) shown.add(j);
    });

    const relPath = relative(getConfig().cwd, file);
    const block = Array.from(shown).sort((a, b) => a - b).map(i =>
      `${relPath}:${i + 1}${matched.includes(i) ? ":" : "-"}${lines[i]}`
    ).join("\n");
    results.push(block);
  }

  if (results.length === 0) return "No matches found.";
  return results.join("\n---\n");
}

// ─── list_dir ─────────────────────────────────────────────────────────────────
export function listDir(args: { path?: string }): string {
  const dir = args.path ? resolvePath(args.path) : getConfig().cwd;
  if (!existsSync(dir)) return `Error: Directory not found: ${dir}`;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .map(e => `${e.isDirectory() ? "d" : "f"} ${e.name}`)
      .join("\n") || "(empty)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ─── bash ─────────────────────────────────────────────────────────────────────
export function bashExec(args: { command: string; cwd?: string; timeout?: number }): string {
  const cwd = args.cwd ? resolvePath(args.cwd) : getConfig().cwd;
  const timeout = args.timeout ?? 30000;
  try {
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "bash";
    const shellArgs = isWin ? ["-NoProfile", "-NonInteractive", "-Command", args.command] : ["-c", args.command];

    const result = spawnSync(shell, shellArgs, {
      cwd,
      timeout,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const exit = result.status ?? (result.error ? 1 : 0);
    return exit === 0
      ? out || "(no output)"
      : `Exit ${exit}:\n${out || result.error?.message || "(no output)"}`;
  } catch (e: any) {
    return `Error executing command: ${e.message}`;
  }
}

// ─── delete_file ──────────────────────────────────────────────────────────────
export function deleteFile(args: { path: string }): string {
  if (!args.path) return "Error: path is required.";
  const fp = resolvePath(args.path);
  if (!existsSync(fp)) return `Error: File not found: ${fp}`;
  if (statSync(fp).isDirectory()) return `Error: Path is a directory. Use bash command to remove directories if needed.`;
  try {
    unlinkSync(fp);
    return `Deleted ${relative(getConfig().cwd, fp)}`;
  } catch (e: any) {
    return `Error deleting file: ${e.message}`;
  }
}

// Normalize common arg-name variations models emit, so a slightly-off tool call
// still works (covers native tool calls too, not just the prompted parser).
function normalizeArgs(args: any): any {
  if (!args || typeof args !== "object") return args;
  if (!args.path) {
    for (const a of ["file", "filename", "filepath", "file_path", "filePath", "target", "file_name"]) {
      if (args[a]) { args.path = args[a]; break; }
    }
  }
  // edit_file alias variations
  if (args.search && !args.old_string) args.old_string = args.search;
  if ((args.replace ?? args.replacement) && !args.new_string) args.new_string = args.replace ?? args.replacement;
  return args;
}

// ─── dispatcher ───────────────────────────────────────────────────────────────
export async function executeTool(name: string, args: any): Promise<string> {
  args = normalizeArgs(args);
  switch (name) {
    case "read_file": return readFile(args);
    case "write_file": return writeFile(args);
    case "edit_file": return editFile(args);
    case "glob_files": return globFiles(args);
    case "grep_files": return grepFiles(args);
    case "list_dir": return listDir(args);
    case "bash": return bashExec(args);
    case "delete_file": return deleteFile(args);
    default: return `Error: Unknown tool: ${name}`;
  }
}
