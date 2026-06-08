import { spawnSync } from "child_process";
import { platform } from "os";

// Port manager: list what's listening on the machine and free a stuck port.
// The agent starts dev servers with run_server; when a port is already taken
// (EADDRINUSE), it can list_ports to see the culprit and kill_port to free it.
// Command execution is separated from parsing so the parsers can be unit-tested.

export interface PortEntry {
  port: number;
  pid: number;
  process: string;   // image / command name, "" if unknown
  address: string;   // local bind address
}

function run(cmd: string, args: string[]): string {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 6000, maxBuffer: 8 * 1024 * 1024, shell: platform() === "win32" });
    return (r.stdout || "") + (r.status !== 0 && r.stderr ? "" : "");
  } catch {
    return "";
  }
}

// ── Windows: netstat -ano (ports+pids) joined with tasklist (pid→name) ──
export function parseTasklistCsv(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) map.set(Number(m[2]), m[1]!);
  }
  return map;
}

export function parseNetstat(text: string, names: Map<number, string>): PortEntry[] {
  const byPort = new Map<number, PortEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^TCP\b/i.test(line) || !/LISTENING/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1]!;
    const pid = Number(parts[parts.length - 1]);
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!port || !Number.isFinite(pid)) continue;
    if (!byPort.has(port)) byPort.set(port, { port, pid, process: names.get(pid) ?? "", address: local });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// ── Unix: lsof -nP -iTCP -sTCP:LISTEN ──
export function parseLsof(text: string): PortEntry[] {
  const byPort = new Map<number, PortEntry>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^COMMAND\b/.test(line)) continue;
    const t = line.split(/\s+/);
    if (t.length < 9) continue;
    const proc = t[0]!, pid = Number(t[1]);
    const name = t.find(x => /:\d+$/.test(x)) ?? t[8]!;
    const pm = name.match(/:(\d+)$/);
    const port = pm ? Number(pm[1]) : NaN;
    if (!port || !Number.isFinite(pid)) continue;
    if (!byPort.has(port)) byPort.set(port, { port, pid, process: proc, address: name });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function listListeningPorts(): PortEntry[] {
  if (platform() === "win32") {
    const names = parseTasklistCsv(run("tasklist", ["/FO", "CSV", "/NH"]));
    return parseNetstat(run("netstat", ["-ano", "-p", "TCP"]), names);
  }
  let out = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (out.trim()) return parseLsof(out);
  return [];
}

export function killPid(pid: number): boolean {
  try {
    if (platform() === "win32") spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { shell: true });
    else process.kill(pid, "SIGKILL");
    return true;
  } catch { return false; }
}

export function killPort(port: number): { port: number; killed: { pid: number; process: string }[]; ok: boolean } {
  const targets = listListeningPorts().filter(e => e.port === port);
  const seen = new Set<number>();
  const killed: { pid: number; process: string }[] = [];
  for (const t of targets) {
    if (seen.has(t.pid)) continue;
    seen.add(t.pid);
    if (killPid(t.pid)) killed.push({ pid: t.pid, process: t.process });
  }
  return { port, killed, ok: killed.length > 0 };
}
