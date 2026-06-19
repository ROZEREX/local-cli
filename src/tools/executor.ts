import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "fs";
import { resolve, join, dirname, relative } from "path";
import { glob } from "glob";
import { spawnSync } from "child_process";
import { getConfig } from "../config";
import { startServer, serverLogs, stopServer, listServers, getServer, waitForStartup } from "../proc";
import { listListeningPorts, killPort } from "../ports";
import { browserOpen, browserReadText, browserClick, browserType, browserScroll, browserElements, browserScreenshot, browserConsole, browserClose } from "../browser";
import { captureDesktop, analyzeImage } from "../vision";
import { systemInfo, recommendModels, describeSystem } from "../sysinfo";
import { sendCommand, extensionConnected } from "../extbridge";
import {
  readActiveProfile, getActiveProfileName, readProfileByName, writeProfileByName,
  setActiveProfile, listProfileNames,
} from "../profile";
import { recordFileChange } from "../history";
import { readMemory, addMemory } from "../memory";
import { addTask, completeTask, describeTasks } from "../tasks";
import { searchCode, formatSearchResults, ensureIndex } from "../search";
import { describeIndex } from "../indexer";
import { browserNetwork, browserPerformance } from "../browser";

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
    const before = existsSync(fp) ? readFileSync(fp, "utf-8") : null;
    writeFileSync(fp, args.content, "utf-8");
    recordFileChange("write_file", fp, before, args.content);
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

// Dice bigram similarity of two strings (0..1) — cheap and word-order tolerant.
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a), mb = bigrams(b);
  let overlap = 0;
  for (const [bg, ca] of ma) overlap += Math.min(ca, mb.get(bg) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

// Last-resort fuzzy stage: find the file block MOST SIMILAR to the search text
// (per-line Dice similarity, whitespace-collapsed) and replace it — handles
// models that paraphrase a comment, drop a trailing comma, or slightly misquote
// a line. Only applies when there's a single clearly-best confident match.
const FUZZY_THRESHOLD = 0.88;
const FUZZY_MARGIN = 0.04;

function fuzzyBlockReplace(
  content: string,
  oldStr: string,
  newStr: string
): { updated: string; score: number } | { error: string } | null {
  const fileLines = content.split("\n");
  const searchLines = oldStr.split("\n");
  if (searchLines.length === 0 || fileLines.length < searchLines.length) return null;
  const norm = (l: string) => l.replace(/\s+/g, " ").trim();
  const fn = fileLines.map(norm);
  const sn = searchLines.map(norm);

  let best = -1, bestScore = 0, secondScore = 0;
  for (let i = 0; i + sn.length <= fn.length; i++) {
    let sum = 0;
    for (let j = 0; j < sn.length; j++) sum += diceSimilarity(fn[i + j]!, sn[j]!);
    const score = sum / sn.length;
    if (score > bestScore) { secondScore = bestScore; bestScore = score; best = i; }
    else if (score > secondScore) secondScore = score;
  }
  if (best === -1 || bestScore < FUZZY_THRESHOLD) return null;
  if (secondScore > bestScore - FUZZY_MARGIN) {
    return { error: `old_string matches multiple locations about equally well (similarity ${(bestScore * 100).toFixed(0)}%). Add more surrounding context to disambiguate.` };
  }
  const result = fileLines.slice();
  result.splice(best, sn.length, ...newStr.split("\n"));
  return { updated: result.join("\n"), score: bestScore };
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
    const write = (text: string) => {
      const final = text.replace(/\n/g, eol);
      writeFileSync(fp, final, "utf-8");
      recordFileChange("edit_file", fp, raw, final);
    };

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
      if (res.error) return `Error: ${res.error}`;
      // 3. Similarity match (handles slightly-misquoted lines) — single edits only.
      if (!args.replace_all) {
        const fz = fuzzyBlockReplace(content, oldStr, newStr);
        if (fz && "error" in fz) return `Error: ${fz.error}`;
        if (fz) {
          write(fz.updated);
          return `Edited ${rel} (fuzzy match, ${(fz.score * 100).toFixed(0)}% similar — verify with read_file that the result is what you intended)`;
        }
      }
      return `Error: old_string not found in ${args.path}. Read the file again and copy the exact text (including indentation) to replace.`;
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
    const matches = await glob(args.pattern, {
      cwd,
      nodir: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/build/**"]
    });
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
    files = await glob(pattern, {
      cwd: searchPath,
      nodir: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/build/**"]
    });
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

// Commands that legitimately take a while (package installs, builds, tests,
// docker, etc.) get a longer default timeout so they aren't killed mid-run.
const LONG_RUNNING_CMD = /\b(install|ci|update|upgrade|add|build|compile|bundle|test|prune|dedupe|rebuild|docker|gradle|mvn|cargo|pip|composer|webpack|vite build|tsc)\b/i;

function defaultBashTimeout(command: string): number {
  return LONG_RUNNING_CMD.test(command) ? 300_000 : 120_000; // 5 min vs 2 min
}

// ─── bash ─────────────────────────────────────────────────────────────────────
export function bashExec(args: { command: string; cwd?: string; timeout?: number }): string {
  const cwd = args.cwd ? resolvePath(args.cwd) : getConfig().cwd;
  const timeout = args.timeout ?? defaultBashTimeout(args.command);
  try {
    const cfg = getConfig();
    const isWin = process.platform === "win32";
    let shell: string;
    let shellArgs: string[];
    if (cfg.sandbox === "docker" || cfg.sandbox === "podman") {
      // Sandboxed execution: run the command inside a throwaway container with
      // the project mounted at /work. The engine is invoked directly (no host
      // shell) so nested quoting can't break out.
      shell = cfg.sandbox;
      shellArgs = ["run", "--rm", "-v", `${cwd}:/work`, "-w", "/work", cfg.sandboxImage, "sh", "-lc", args.command];
    } else {
      shell = isWin ? "powershell.exe" : "bash";
      shellArgs = isWin ? ["-NoProfile", "-NonInteractive", "-Command", args.command] : ["-c", args.command];
    }

    const result = spawnSync(shell, shellArgs, {
      cwd,
      timeout,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error && (result.error as any).code === "ENOENT" && cfg.sandbox !== "none") {
      return `Error: sandbox is set to "${cfg.sandbox}" but the ${cfg.sandbox} binary was not found. Install it, or disable the sandbox with /sandbox off.`;
    }

    // Timeout: spawnSync sets error.code ETIMEDOUT (and SIGTERM). Make it clear
    // rather than surfacing the raw "spawnSync powershell.exe ETIMEDOUT".
    const errCode = (result.error as any)?.code;
    if (errCode === "ETIMEDOUT" || result.signal === "SIGTERM") {
      const partial = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      return `Command timed out after ${Math.round(timeout / 1000)}s: ${args.command}\n` +
        (partial ? `Partial output:\n${partial}\n` : "") +
        `If it genuinely needs longer, re-run with a larger timeout. For a long-lived process (a dev server/host), use run_server instead of bash.`;
    }
    if (result.error) {
      return `Error executing command: ${result.error.message}`;
    }

    const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const exit = result.status ?? 0;
    if (exit !== 0 && isWin) {
      const hints: string[] = [];
      const cmd = args.command;
      if (cmd.includes("rm ") && (cmd.includes("-r") || cmd.includes("-f"))) {
        hints.push("On Windows PowerShell, UNIX-style 'rm -rf' or 'rm -r' is not supported because 'rm' is an alias for 'Remove-Item'. Use 'Remove-Item -Recurse -Force <path>' instead.");
      }
      if (cmd.includes("mkdir ") && cmd.includes("-p")) {
        hints.push("On Windows PowerShell, 'mkdir -p' is not supported. Use 'New-Item -ItemType Directory <path>' instead.");
      }
      if (cmd.includes("&&")) {
        hints.push("On Windows PowerShell, '&&' is not supported. Use ';' to separate multiple commands.");
      }
      if (/\btouch\b/.test(cmd)) {
        hints.push("On Windows, 'touch' is not supported. Use 'New-Item <file>' or 'echo $null > <file>' instead.");
      }
      if (cmd.includes("ls ") && (cmd.includes("-l") || cmd.includes("-a"))) {
        hints.push("On Windows PowerShell, 'ls' aliases to 'Get-ChildItem' which does not support UNIX flags like '-la' or '-lh'. Use Get-ChildItem without those flags instead.");
      }
      if (cmd.includes("cp ") && (cmd.includes("-r") || cmd.includes("-R"))) {
        hints.push("On Windows PowerShell, UNIX-style 'cp -r' is not supported. Use 'Copy-Item -Recurse' instead.");
      }
      if (hints.length > 0) {
        return `Exit ${exit}:\n${out || "(no output)"}\n\n[Windows PowerShell Tips:\n${hints.map(h => `- ${h}`).join("\n")}]`;
      }
    }
    return exit === 0
      ? out || "(no output)"
      : `Exit ${exit}:\n${out || "(no output)"}`;
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
    let before: string | null = null;
    try { before = readFileSync(fp, "utf-8"); } catch { /* binary or unreadable — skip history */ }
    unlinkSync(fp);
    if (before !== null) recordFileChange("delete_file", fp, before, null);
    return `Deleted ${relative(getConfig().cwd, fp)}`;
  } catch (e: any) {
    return `Error deleting file: ${e.message}`;
  }
}

// ─── run_server (long-running background process) ─────────────────────────────
export async function runServer(args: { command: string; cwd?: string; wait?: number }): Promise<string> {
  if (!args.command) return "Error: command is required (e.g. 'npm run dev').";
  // Don't start a DUPLICATE: if the same command is already running here, reuse it
  // (otherwise repeated "let me start the server" calls pile up processes that all
  // fight for the same port).
  const dir = args.cwd ? resolve(getConfig().cwd, args.cwd) : getConfig().cwd;
  const existing = listServers().find(p => p.status === "running" && p.command.trim() === args.command.trim() && p.cwd === dir);
  if (existing) {
    const recent = serverLogs(existing.id, 20).join("\n");
    return `That server is ALREADY running as [${existing.id}]${existing.url ? ` at ${existing.url}` : ""} — not starting a duplicate.\nCommand: ${existing.command}\nRecent output:\n${recent || "(none)"}\n\nUse server_logs id="${existing.id}" to read more, or stop_server id="${existing.id}" to stop it. Do not call run_server again for this — it's up.`;
  }
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

// ─── list_ports ───────────────────────────────────────────────────────────────
export function listPortsTool(): string {
  const ports = listListeningPorts();
  if (!ports.length) return "No listening TCP ports found (or the port list couldn't be read on this system).";
  const w = Math.max(...ports.map(p => String(p.port).length));
  return "Listening TCP ports:\n" + ports
    .map(p => `  ${String(p.port).padStart(w)}  pid ${p.pid}${p.process ? "  " + p.process : ""}${p.address ? "  (" + p.address + ")" : ""}`)
    .join("\n") + "\n\nFree one with kill_port port=<n>.";
}

// ─── kill_port ────────────────────────────────────────────────────────────────
export function killPortTool(args: { port?: number | string }): string {
  const port = Number(args.port);
  if (!port || !Number.isFinite(port)) return "Error: a numeric port is required (e.g. kill_port port=3000).";
  const r = killPort(port);
  if (!r.ok) return `Nothing was listening on port ${port} (or it couldn't be killed). It should be free now.`;
  return `Freed port ${port} — killed ${r.killed.map(k => `PID ${k.pid}${k.process ? " (" + k.process + ")" : ""}`).join(", ")}.`;
}

// ─── browser control (CDP) ────────────────────────────────────────────────────
export async function browserOpenTool(args: { url?: string }): Promise<string> {
  if (!args.url) return "Error: a url is required (e.g. browser_open url=\"http://localhost:3000\").";
  try {
    const r = await browserOpen(args.url);
    return `Opened ${r.url}${r.title ? ` — "${r.title}"` : ""} in the browser. Use browser_read to see the page text, browser_screenshot to look at it, browser_click to interact.`;
  } catch (e: any) { return `Error opening browser: ${e.message}`; }
}
export async function browserReadTool(): Promise<string> {
  try {
    const text = await browserReadText();
    const els = await browserElements().catch(() => "");
    const errs = await browserConsole().catch(() => "");
    return `Page text:\n${text || "(empty)"}` +
      (els ? `\n\nInteractive elements (use the text or a selector with browser_click / browser_type):\n${els}` : "") +
      (errs ? `\n\nConsole errors:\n${errs}` : "");
  } catch (e: any) { return `Error reading page: ${e.message}`; }
}
export async function browserClickTool(args: { target?: string; selector?: string; text?: string }): Promise<string> {
  const target = args.target || args.selector || args.text;
  if (!target) return "Error: provide a CSS selector or visible text to click (target).";
  try { return await browserClick(target); } catch (e: any) { return `Error clicking: ${e.message}`; }
}
export async function browserTypeTool(args: { target?: string; selector?: string; text?: string }): Promise<string> {
  const target = args.target || args.selector;
  const text = args.text;
  if (!target) return "Error: provide a CSS selector, placeholder, or label text (target).";
  if (text === undefined || text === null) return "Error: text is required.";
  try { return await browserType(target, text); } catch (e: any) { return `Error typing: ${e.message}`; }
}
export async function browserScrollTool(args: { to?: string }): Promise<string> {
  try { return await browserScroll(args.to || "down"); } catch (e: any) { return `Error scrolling: ${e.message}`; }
}
export async function browserScreenshotTool(args: { question?: string }): Promise<string> {
  try {
    const b64 = await browserScreenshot();
    const analysis = await analyzeImage(b64, args.question || "Describe this web page and point out any layout problems, errors, or broken elements.");
    return `Looked at the page (screenshot ${Math.round(b64.length * 0.75 / 1024)} KB).\n\n${analysis}`;
  } catch (e: any) { return `Error taking browser screenshot: ${e.message}`; }
}
export async function browserCloseTool(): Promise<string> {
  try { await browserClose(); return "Closed the controlled browser."; } catch (e: any) { return `Error closing browser: ${e.message}`; }
}

// ─── screenshot (desktop) + vision analysis ───────────────────────────────────
export async function screenshotTool(args: { question?: string }): Promise<string> {
  try {
    const b64 = captureDesktop();
    const analysis = await analyzeImage(b64, args.question || "Describe what is on the screen right now. Note what app/window is focused and anything notable.");
    return `Captured the screen.\n\n${analysis}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

// ─── page_* (act on the user's LIVE tab via the browser extension) ────────────
const NO_EXT = "No browser extension connected. Ask the user to open the local-cli panel (the floating chat) on the page they want you to work with.";

export async function pageReadTool(): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  try {
    const r = await sendCommand("read");
    const els = (r.elements || []).map((e: any, i: number) => `  [${i}] <${e.tag}> ${e.text}${e.href ? "  → " + e.href : ""}`).join("\n");
    return `Page: ${r.title}\nURL: ${r.url}\n\nVisible text:\n${(r.text || "").slice(0, 5000)}\n\nClickable elements (use the text with page_click):\n${els || "  (none found)"}`;
  } catch (e: any) { return `Error reading the page: ${e.message}`; }
}
export async function pageFindTool(args: { query?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.query) return "Error: a query (text to search for) is required.";
  try {
    const r = await sendCommand("find", { query: args.query });
    if (!r.matches?.length) return `No elements matching "${args.query}".`;
    return `Found ${r.matches.length} match(es) (highlighted on the page):\n` + r.matches.map((m: any, i: number) => `  [${i}] <${m.tag}> ${m.text}${m.href ? "  → " + m.href : ""}`).join("\n");
  } catch (e: any) { return `Error: ${e.message}`; }
}
export async function pageClickTool(args: { target?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.target) return "Error: target (visible text or CSS selector) is required.";
  try {
    const r = await sendCommand("click", { target: args.target });
    return r.ok ? `Moved the cursor to and clicked: "${r.label}".` : `Couldn't find an element matching "${args.target}" to click.`;
  } catch (e: any) { return `Error clicking: ${e.message}`; }
}
export async function pageTypeTool(args: { target?: string; text?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.target) return "Error: target (visible text, placeholder, or CSS selector) is required.";
  if (args.text === undefined || args.text === null) return "Error: text is required.";
  try {
    const r = await sendCommand("type", { target: args.target, text: args.text });
    return r.ok ? `Moved the cursor to and typed into: "${r.label}".` : `Couldn't find an element matching "${args.target}" to type into.`;
  } catch (e: any) { return `Error typing: ${e.message}`; }
}
export async function pageHighlightTool(args: { target?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.target) return "Error: target is required.";
  try {
    const r = await sendCommand("highlight", { target: args.target });
    return r.ok ? `Highlighted ${r.count} element(s) on the page for the user.` : `Nothing matched "${args.target}".`;
  } catch (e: any) { return `Error: ${e.message}`; }
}
export async function pageScrollTool(args: { to?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  try { await sendCommand("scroll", { to: args.to || "down" }); return `Scrolled ${args.to || "down"}.`; }
  catch (e: any) { return `Error: ${e.message}`; }
}
export async function pageOpenTool(args: { url?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.url) return "Error: a url is required.";
  try {
    const r = await sendCommand("open_tab", { url: args.url });
    return r.ok ? `Opened ${r.url} in a new browser tab. Use page_read to see it, then page_click/page_find to act on it.` : `Couldn't open the tab: ${r.error || "unknown"}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}
export async function pageNavigateTool(args: { url?: string }): Promise<string> {
  if (!extensionConnected()) return NO_EXT;
  if (!args.url) return "Error: a url is required.";
  try {
    const r = await sendCommand("navigate", { url: args.url });
    return r.ok ? `Navigated the current tab to ${r.url}.` : `Couldn't navigate: ${r.error || "no active tab — use page_open first"}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

// ─── system_info (hardware eval + model recommendations) ──────────────────────
export function systemInfoTool(): string {
  const info = systemInfo();
  return describeSystem(info, recommendModels(info));
}

// ─── search_code (semantic workspace search) ──────────────────────────────────
export async function searchCodeTool(args: { query?: string; limit?: number }): Promise<string> {
  const query = (args.query ?? "").trim();
  if (!query) return "Error: a query is required (e.g. search_code query=\"where are JWT tokens generated\").";
  try {
    const r = await searchCode(query, Math.min(Math.max(args.limit ?? 8, 1), 20));
    return formatSearchResults(query, r);
  } catch (e: any) {
    return `Error searching code: ${e.message}. Try grep_files for an exact-string search.`;
  }
}

// ─── index_workspace ──────────────────────────────────────────────────────────
export async function indexWorkspaceTool(): Promise<string> {
  try {
    const idx = await ensureIndex({ rebuild: true });
    return describeIndex(idx);
  } catch (e: any) {
    return `Error indexing workspace: ${e.message}`;
  }
}

// ─── remember / recall (per-project agent memory) ─────────────────────────────
export function rememberTool(args: { content?: string; fact?: string; text?: string }): string {
  const content = (args.content ?? args.fact ?? args.text ?? "").trim();
  if (!content) return "Error: provide the fact(s) to remember in 'content' (short markdown bullets).";
  const { added, skipped } = addMemory(content);
  if (added === 0) return "Already in project memory — nothing new to add.";
  return `Remembered ${added} fact${added === 1 ? "" : "s"} in this project's memory (.local-cli/memory.md)${skipped ? `, ${skipped} duplicate(s) skipped` : ""}. It will be available in every future session here.`;
}

export function recallTool(): string {
  const mem = readMemory();
  if (!mem) return "Project memory is empty. Save durable facts about this project with the remember tool.";
  return `Project memory (.local-cli/memory.md):\n\n${mem}`;
}

// ─── task tools (persistent per-project checklist) ────────────────────────────
export function taskAddTool(args: { text?: string; task?: string; content?: string }): string {
  const text = (args.text ?? args.task ?? args.content ?? "").trim();
  if (!text) return "Error: provide the task text (e.g. task_add text=\"Add OAuth support\").";
  addTask(text);
  return `Added task: "${text}".\n\n${describeTasks()}`;
}

export function taskDoneTool(args: { task?: string; text?: string; index?: number | string }): string {
  const ref = args.index ?? args.task ?? args.text;
  if (ref === undefined || ref === null || String(ref).trim() === "") {
    return "Error: identify the task to complete by its number or part of its text.";
  }
  const r = completeTask(typeof ref === "number" ? ref : String(ref).trim());
  if (!r.ok) return `No task matched "${ref}". Current list:\n${describeTasks()}`;
  return `Marked done: "${r.task!.text}".\n\n${describeTasks()}`;
}

export function taskListTool(): string {
  return describeTasks();
}

// ─── spawn_agents (multi-agent mode) ──────────────────────────────────────────
export async function spawnAgentsTool(args: { tasks?: string[] | string; allow_writes?: boolean }): Promise<string> {
  let tasks: string[] = Array.isArray(args.tasks)
    ? args.tasks.map(t => String(t)).filter(t => t.trim())
    : typeof args.tasks === "string"
      ? args.tasks.split(/\||\n/).map(t => t.trim()).filter(Boolean)
      : [];
  if (tasks.length === 0) return "Error: provide 1-4 tasks (array, or one per line / separated by |).";
  const { runSubAgents, formatAgentResults } = await import("../agents");
  const results = await runSubAgents(tasks, { allowWrites: !!args.allow_writes });
  return formatAgentResults(results);
}

// ─── browser devtools ─────────────────────────────────────────────────────────
export async function browserConsoleTool(): Promise<string> {
  try {
    const logs = await browserConsole();
    return logs ? `Browser console:\n${logs.split("\n").slice(-80).join("\n")}` : "Browser console is empty (no logs since the last navigation).";
  } catch (e: any) { return `Error reading console: ${e.message}`; }
}
export async function browserNetworkTool(): Promise<string> {
  try { return await browserNetwork(); } catch (e: any) { return `Error reading network: ${e.message}`; }
}
export async function browserPerformanceTool(): Promise<string> {
  try { return await browserPerformance(); } catch (e: any) { return `Error reading performance: ${e.message}`; }
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
  if (args.port == null) { for (const a of ["portNumber", "port_number", "p"]) if (args[a] != null) { args.port = args[a]; break; } }
  if (!args.url) { for (const a of ["address", "link", "href", "uri"]) if (args[a]) { args.url = args[a]; break; } }
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
  // search_code
  semantic_search: "search_code", code_search: "search_code", searchcode: "search_code",
  // memory
  save_memory: "remember", memorize: "remember", add_memory: "remember",
  read_memory: "recall", get_memory: "recall", recall_memory: "recall",
  // tasks
  add_task: "task_add", create_task: "task_add", todo_add: "task_add",
  complete_task: "task_done", finish_task: "task_done", mark_done: "task_done",
  list_tasks: "task_list", tasks: "task_list", todo_list: "task_list",
  // index
  index_project: "index_workspace", build_index: "index_workspace", reindex: "index_workspace",
  // agents
  spawn_agent: "spawn_agents", sub_agents: "spawn_agents", run_agents: "spawn_agents",
  // browser devtools
  console_logs: "browser_console", network_requests: "browser_network",
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
    case "list_ports": return listPortsTool();
    case "kill_port": return killPortTool(args);
    case "browser_open": return await browserOpenTool(args);
    case "browser_read": return await browserReadTool();
    case "browser_click": return await browserClickTool(args);
    case "browser_type": return await browserTypeTool(args);
    case "browser_scroll": return await browserScrollTool(args);
    case "browser_screenshot": return await browserScreenshotTool(args);
    case "browser_close": return await browserCloseTool();
    case "screenshot": return await screenshotTool(args);
    case "system_info": return systemInfoTool();
    case "page_read": return await pageReadTool();
    case "page_find": return await pageFindTool(args);
    case "page_click": return await pageClickTool(args);
    case "page_type": return await pageTypeTool(args);
    case "page_highlight": return await pageHighlightTool(args);
    case "page_scroll": return await pageScrollTool(args);
    case "page_open": return await pageOpenTool(args);
    case "page_navigate": return await pageNavigateTool(args);
    case "search_code": return await searchCodeTool(args);
    case "index_workspace": return await indexWorkspaceTool();
    case "remember": return rememberTool(args);
    case "recall": return recallTool();
    case "task_add": return taskAddTool(args);
    case "task_done": return taskDoneTool(args);
    case "task_list": return taskListTool();
    case "spawn_agents": return await spawnAgentsTool(args);
    case "browser_console": return await browserConsoleTool();
    case "browser_network": return await browserNetworkTool();
    case "browser_performance": return await browserPerformanceTool();
    default: return `Error: Unknown tool: ${name}`;
  }
}
