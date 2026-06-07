import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import { glob } from "glob";
import { spawnSync } from "child_process";
import { getConfig } from "../config";
import { startServer, serverLogs, stopServer, listServers, getServer, waitForStartup } from "../proc";
import {
  readActiveProfile, getActiveProfileName, readProfileByName, writeProfileByName,
  setActiveProfile, listProfileNames,
} from "../profile";

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

// ─── run_server (long-running background process) ─────────────────────────────
export async function runServer(args: { command: string; cwd?: string; wait?: number }): Promise<string> {
  if (!args.command) return "Error: command is required (e.g. 'npm run dev').";
  const proc = startServer(args.command, args.cwd);
  // Give it a moment to boot so we can return startup output / an early crash.
  const waitMs = Math.min(Math.max(args.wait ?? 2500, 0), 15000);
  await waitForStartup(proc, waitMs);

  const recent = serverLogs(proc.id, 40).join("\n");
  if (proc.status === "exited") {
    return `Server [${proc.id}] exited immediately (code ${proc.exitCode}). It is NOT running.\nCommand: ${args.command}\nOutput:\n${recent || "(no output)"}\n\nFix the cause and start it again.`;
  }
  const where = proc.url ? `\nDetected URL: ${proc.url}` : "";
  return `Server [${proc.id}] started and is running in the background.\nCommand: ${args.command}${where}\nStartup output:\n${recent || "(no output yet)"}\n\nUse server_logs id="${proc.id}" to read more output later (e.g. to catch runtime errors), and stop_server id="${proc.id}" to stop it.`;
}

// ─── server_logs ──────────────────────────────────────────────────────────────
export function serverLogsTool(args: { id?: string; lines?: number }): string {
  const all = listServers();
  if (all.length === 0) return "No background servers have been started.";
  const id = args.id || all[all.length - 1]!.id;
  const proc = getServer(id);
  if (!proc) return `Error: no server with id "${id}". Running servers: ${all.map(p => p.id).join(", ")}`;
  const lines = serverLogs(id, args.lines ?? 80).join("\n");
  const state = proc.status === "running" ? "running" : `exited (code ${proc.exitCode})`;
  return `Server [${id}] — ${state}${proc.url ? ` — ${proc.url}` : ""}\nCommand: ${proc.command}\n\n${lines || "(no output)"}`;
}

// ─── stop_server ──────────────────────────────────────────────────────────────
export function stopServerTool(args: { id?: string }): string {
  const all = listServers();
  if (all.length === 0) return "No background servers to stop.";
  const id = args.id || all[all.length - 1]!.id;
  if (!getServer(id)) return `Error: no server with id "${id}". Known: ${all.map(p => p.id).join(", ")}`;
  stopServer(id);
  return `Stopped server [${id}].`;
}

// ─── list_servers ─────────────────────────────────────────────────────────────
export function listServersTool(): string {
  const all = listServers();
  if (all.length === 0) return "No background servers running.";
  return all
    .map(p => `[${p.id}] ${p.status === "running" ? "● running" : `○ exited(${p.exitCode})`}  ${p.url ?? ""}  — ${p.command}`)
    .join("\n");
}

// ─── read_profile ─────────────────────────────────────────────────────────────
export function readProfileTool(args: { name?: string }): string {
  const name = args.name || getActiveProfileName();
  if (!name) {
    const all = listProfileNames();
    return all.length
      ? `No active profile selected. Existing profiles: ${all.join(", ")}. The user can pick one with /profiles.`
      : "No coding profile exists yet. You can create one with update_profile once you learn the user's style.";
  }
  const content = name === getActiveProfileName() ? readActiveProfile() : readProfileByName(name);
  if (!content) return `Profile "${name}" is empty or not found.`;
  return `Coding profile "${name}":\n\n${content}`;
}

// ─── update_profile ───────────────────────────────────────────────────────────
export function updateProfileTool(args: { content?: string; name?: string; mode?: string }): string {
  if (!args.content || !args.content.trim()) {
    return "Error: content was not provided. Put the rule(s) to save inside the tool body.";
  }
  // Target the named profile, else the active one, else create "default".
  const target = args.name || getActiveProfileName() || "default";
  const mode = args.mode === "replace" ? "replace" : "append";
  const existed = !!readProfileByName(target);
  writeProfileByName(target, args.content, mode);
  // Make sure the profile we just wrote is the one being used.
  if (!getActiveProfileName()) setActiveProfile(target);
  const verb = mode === "replace" ? "Saved" : existed ? "Appended to" : "Created";
  return `${verb} coding profile "${target}". It will guide your work in every project from now on.`;
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
  // server tool alias variations
  if (!args.id) {
    for (const a of ["server_id", "serverId", "server", "pid"]) {
      if (args[a]) { args.id = args[a]; break; }
    }
  }
  if (!args.command && args.cmd) args.command = args.cmd;
  return args;
}

// Models often invent slightly different tool names (especially code models that
// narrate calls as text). Map the common ones onto our real tools so the call
// still runs instead of failing with "Unknown tool".
const TOOL_ALIASES: Record<string, string> = {
  // list_dir
  read_dir: "list_dir", readdir: "list_dir", list_directory: "list_dir", listdir: "list_dir", ls: "list_dir", dir: "list_dir",
  // read_file
  cat: "read_file", open_file: "read_file", view_file: "read_file", get_file: "read_file", openfile: "read_file",
  // write_file
  create_file: "write_file", new_file: "write_file", save_file: "write_file", writefile: "write_file", createfile: "write_file",
  // edit_file
  modify_file: "edit_file", replace_in_file: "edit_file", update_file: "edit_file", apply_patch: "edit_file", str_replace: "edit_file", patch_file: "edit_file",
  // delete_file
  remove_file: "delete_file", rm: "delete_file", del: "delete_file", unlink: "delete_file", deletefile: "delete_file",
  // glob_files
  find: "glob_files", find_files: "glob_files", glob: "glob_files", findfiles: "glob_files",
  // grep_files
  search: "grep_files", grep: "grep_files", search_files: "grep_files", ripgrep: "grep_files", rg: "grep_files",
  // bash
  run: "bash", shell: "bash", exec: "bash", execute: "bash", run_command: "bash", run_shell: "bash", terminal: "bash", sh: "bash", command: "bash",
  // run_server
  start_server: "run_server", run_dev: "run_server", serve: "run_server", dev_server: "run_server",
  // stop_server
  kill_server: "stop_server",
  // server_logs
  logs: "server_logs", get_logs: "server_logs", tail_logs: "server_logs",
};

export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

// ─── dispatcher ───────────────────────────────────────────────────────────────
export async function executeTool(name: string, args: any): Promise<string> {
  name = canonicalToolName(name);
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
    case "run_server": return await runServer(args);
    case "server_logs": return serverLogsTool(args);
    case "stop_server": return stopServerTool(args);
    case "list_servers": return listServersTool();
    case "read_profile": return readProfileTool(args);
    case "update_profile": return updateProfileTool(args);
    default: return `Error: Unknown tool: ${name}`;
  }
}
