import { spawn, type ChildProcess } from "child_process";
import { platform } from "os";
import { getConfig } from "./config";
import { resolve } from "path";

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
  if (p.status === "running") {
    try {
      if (platform() === "win32") {
        // Kill the whole tree so child node/bun processes die too.
        spawn("taskkill", ["/pid", String(p.child.pid), "/T", "/F"]);
      } else {
        p.child.kill("SIGTERM");
      }
    } catch {
      /* already gone */
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
