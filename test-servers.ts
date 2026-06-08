import "./test-config-setup";
import { saveConfig } from "./src/config";
import { executeTool } from "./src/tools/executor";
import { listServers, stopAllServers } from "./src/proc";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "lcli-srv-"));
saveConfig({ cwd: dir });

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const run = async () => {
  // A command that keeps running and prints a "listening" line so URL detection
  // has something to find. Node is guaranteed present (Bun ships a node shim);
  // we use a portable shell loop instead to avoid runtime assumptions.
  // Use a long-lived process: ping-like sleep loop that emits a port line first.
  const isWin = process.platform === "win32";
  const longCmd = isWin
    ? `Write-Output 'Server listening on http://localhost:4321'; Start-Sleep -Seconds 30`
    : `echo 'Server listening on http://localhost:4321'; sleep 30`;

  // run_server starts it in the background and returns quickly.
  let r = await executeTool("run_server", { command: longCmd, wait: 1200 });
  check("run_server reports running", r.includes("started and is running"), r);
  check("run_server captured the URL", r.includes("http://localhost:4321"), r);

  const servers = listServers();
  check("registry has one server", servers.length === 1, `len=${servers.length}`);
  const id = servers[0]!.id;
  check("server is in running state", servers[0]!.status === "running");

  // run_server with the SAME command must NOT start a duplicate.
  r = await executeTool("run_server", { command: longCmd, wait: 100 });
  check("re-running the same command reuses the existing server", r.includes("ALREADY running") && r.includes(id), r);
  check("no duplicate process was spawned", listServers().length === 1, `len=${listServers().length}`);

  // server_logs returns the output we saw.
  r = await executeTool("server_logs", { id });
  check("server_logs returns startup output", r.includes("listening on"), r);

  // list_servers shows it.
  r = await executeTool("list_servers", {});
  check("list_servers lists the running server", r.includes(id) && r.includes("running"), r);

  // stop_server stops it.
  r = await executeTool("stop_server", { id });
  check("stop_server confirms stop", r.includes("Stopped"), r);
  await sleep(500);
  check("server marked exited after stop", listServers()[0]!.status === "exited");

  // A command that exits immediately is reported as NOT running.
  r = await executeTool("run_server", { command: isWin ? "Write-Output done" : "echo done", wait: 1500 });
  check("run_server detects immediate exit", r.includes("exited immediately") && r.includes("NOT running"), r);

  // defaults to latest server when no id given
  r = await executeTool("server_logs", {});
  check("server_logs defaults to latest", r.includes("done") || r.includes("exited"), r);

  // alias normalization: server_id instead of id
  const aliasId = listServers()[0]!.id;
  r = await executeTool("stop_server", { server_id: aliasId });
  check("stop_server accepts server_id alias", r.includes("Stopped") || r.includes("no server"), r);

  stopAllServers();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "SERVERS OK" : "SERVERS FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
