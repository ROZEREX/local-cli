import { spawn, spawnSync, type ChildProcess } from "child_process";
import { platform } from "os";
import { getConfig } from "./config";
import { resolve } from "path";
import { killPort } from "./ports";

// Long-running background processes (dev servers, watchers, hosts). Unlike the
// `bash` tool — which runs to completion and blocks — these stay alive after the
// tool returns, so the agent can start `npm run dev`, keep chatting, read the
// server's logs, see errors, and fix them. Tracked in an in-memory registry and
// killed on exit.

export interface ServerProc {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  logs: string[];        // ring buffer of recent output lines
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
  url: string | null;    // detected http URL, if any
  errors: string[];      // error-looking lines not yet reported to the agent
}

// Error/console streaming: lines that look like runtime/build failures are
// collected per server and drained into the agent loop automatically, so the
// model sees crashes without having to ask for server_logs (Cursor-style).
const ERROR_LINE_RE = /\b(error|err!|exception|typeerror|referenceerror|syntaxerror|unhandled(?:\s+promise)?(?:\s+rejection)?|rejection|traceback|panic(?:ked)?|fatal|build failed|compile(?:d with)? errors|eaddrinuse|enoent|cannot find module|module not found|failed to compile|segfault)\b/i;
// Lines that match the pattern but are normal chatter (e.g. "0 errors").
const ERROR_FALSE_POSITIVE_RE = /\b(0 errors?|no errors?|errors?:\s*0|without errors?)\b/i;

function looksLikeError(line: string): boolean {
  return ERROR_LINE_RE.test(line) && !ERROR_FALSE_POSITIVE_RE.test(line);
}

const MAX_LOG_LINES = 400;
const registry = new Map<string, ServerProc>();
let counter = 0;

function nextId(): string {
  counter += 1;
  return `srv${counter}`;
}

// Pull the first http(s) URL or localhost:port out of a chunk of server output,
// so we can tell the user/agent where the thing is listening.
function detectUrl(text: string): string | null {
  const m =
    text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]?)(?::\d+)?(?:\/\S*)?/i) ||
    text.match(/(?:listening|running|ready|started|local).{0,40}?:\s*(\d{2,5})\b/i);
  if (!m) return null;
  if (m[0].startsWith("http")) return m[0].replace("0.0.0.0", "localhost").replace("[::]", "localhost");
  if (m[1]) return `http://localhost:${m[1]}`;
  return null;
}

function appendLog(p: ServerProc, chunk: string) {
  const lines = chunk.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (line === "") continue;
    p.logs.push(line);
    if (looksLikeError(line)) {
      p.errors.push(line);
      if (p.errors.length > 40) p.errors.splice(0, p.errors.length - 40);
    }
    if (!p.url) {
      const u = detectUrl(line);
      if (u) p.url = u;
    }
  }
  if (p.logs.length > MAX_LOG_LINES) p.logs.splice(0, p.logs.length - MAX_LOG_LINES);
}

// Start a background process. Returns its id immediately; the caller can wait a
// moment and read logs to capture startup output / early errors.
export function startServer(command: string, cwd?: string): ServerProc {
  const dir = cwd ? resolve(getConfig().cwd, cwd) : getConfig().cwd;
  const isWin = platform() === "win32";
  const shell = isWin ? "powershell.exe" : "bash";
  const shellArgs = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

  const child = spawn(shell, shellArgs, { cwd: dir, windowsHide: true });
  const proc: ServerProc = {
    id: nextId(),
    command,
    cwd: dir,
    child,
    logs: [],
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    url: null,
    errors: [],
  };

  child.stdout?.on("data", (d) => appendLog(proc, d.toString()));
  child.stderr?.on("data", (d) => appendLog(proc, d.toString()));
  child.on("exit", (code) => { proc.status = "exited"; proc.exitCode = code; });
  child.on("error", (e) => { appendLog(proc, `[spawn error] ${e.message}`); proc.status = "exited"; proc.exitCode = 1; });

  registry.set(proc.id, proc);
  return proc;
}

export function getServer(id: string): ServerProc | undefined {
  return registry.get(id);
}

export function listServers(): ServerProc[] {
  return [...registry.values()];
}

// Recent log lines for a process (most recent `lines`).
export function serverLogs(id: string, lines = 60): string[] {
  const p = registry.get(id);
  if (!p) return [];
  return p.logs.slice(-lines);
}

export function stopServer(id: string): boolean {
  const p = registry.get(id);
  if (!p) return false;

  // Gather ports to kill before stopping process tree
  const portsToKill: number[] = [];
  if (p.url) {
    const match = p.url.match(/:(\d+)(?:\/|$)/);
    if (match && match[1]) {
      const portVal = parseInt(match[1], 10);
      if (!isNaN(portVal)) portsToKill.push(portVal);
    }
  }
  const portRegex = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]?):(\d{2,5})\b/gi;
  for (const line of p.logs) {
    let m;
    portRegex.lastIndex = 0;
    while ((m = portRegex.exec(line)) !== null) {
      if (m[1]) {
        const portVal = parseInt(m[1], 10);
        if (!isNaN(portVal) && !portsToKill.includes(portVal)) {
          portsToKill.push(portVal);
        }
      }
    }
  }

  if (p.status === "running") {
    try {
      if (platform() === "win32") {
        // Kill the whole tree so child node/bun processes die too.
        spawnSync("taskkill", ["/pid", String(p.child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        p.child.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
    p.status = "exited";
  }

  // Forcefully kill any remaining processes listening on the server's ports
  for (const port of portsToKill) {
    try {
      killPort(port);
    } catch {
      /* ignore */
    }
  }

  return true;
}

// Kill everything — called when the CLI exits so we don't leak servers.
export function stopAllServers(): void {
  for (const p of registry.values()) {
    if (p.status === "running") stopServer(p.id);
  }
}

// Drain error lines that haven't been reported yet. Called by the chat loop
// between iterations: returns each server's pending error lines (and clears
// them), so the agent automatically SEES runtime/build errors as they happen.
export function drainServerErrors(): { id: string; command: string; lines: string[] }[] {
  const out: { id: string; command: string; lines: string[] }[] = [];
  for (const p of registry.values()) {
    if (p.errors.length === 0) continue;
    out.push({ id: p.id, command: p.command, lines: p.errors.splice(0, p.errors.length) });
  }
  return out;
}

// Wait up to `ms`, resolving early if the process exits — lets startServer's
// caller capture immediate startup output or a crash.
export function waitForStartup(p: ServerProc, ms: number): Promise<void> {
  return new Promise((res) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (p.status === "exited" || Date.now() - start >= ms) {
        clearInterval(tick);
        res();
      }
    }, 100);
  });
}
