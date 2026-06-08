// Tests the port-manager parsers (parsing is separated from running the OS
// commands so it's deterministic). Live listing/killing is platform-specific and
// covered by the live smoke test, not here.
import "./test-config-setup";
import { parseNetstat, parseTasklistCsv, parseLsof } from "./src/ports";
import { executeTool } from "./src/tools/executor";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── Windows: tasklist CSV → pid→name ──
const tasklist = `"System Idle Process","0","Services","0","8 K"
"node.exe","12345","Console","1","123,456 K"
"ollama.exe","6789","Console","1","2,000 K"`;
const names = parseTasklistCsv(tasklist);
check("tasklist maps pid→name", names.get(12345) === "node.exe" && names.get(6789) === "ollama.exe");

// ── Windows: netstat -ano ──
const netstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
  TCP    [::]:3000              [::]:0                 LISTENING       12345
  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       6789
  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4
  TCP    10.0.0.2:50515         140.82.112.21:443     ESTABLISHED     9999`;
const ports = parseNetstat(netstat, names);
check("parses listening ports", ports.length === 3, JSON.stringify(ports.map(p => p.port)));
check("dedupes the same port (ipv4+ipv6)", ports.filter(p => p.port === 3000).length === 1);
check("ignores ESTABLISHED (non-listening)", !ports.some(p => p.port === 50515));
const p3000 = ports.find(p => p.port === 3000)!;
check("attaches pid + process name", p3000.pid === 12345 && p3000.process === "node.exe", JSON.stringify(p3000));
check("ports are sorted ascending", ports[0]!.port <= ports[ports.length - 1]!.port);

// ── Unix: lsof ──
const lsof = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    23456 me   23u  IPv4 0x1234      0t0  TCP *:5173 (LISTEN)
ollama   789 me    7u  IPv6 0xabcd      0t0  TCP [::1]:11434 (LISTEN)`;
const u = parseLsof(lsof);
check("lsof parses port + command", u.some(e => e.port === 5173 && e.process === "node"), JSON.stringify(u));
check("lsof parses ipv6 bracket form", u.some(e => e.port === 11434), JSON.stringify(u));

// ── tool validation ──
const r1 = await executeTool("kill_port", {});
check("kill_port requires a numeric port", r1.includes("numeric port is required"), r1);
const r2 = await executeTool("kill_port", { port: "notaport" });
check("kill_port rejects a non-number", r2.includes("numeric port is required"), r2);

console.log(`\n${fail === 0 ? "PORTS OK" : "PORTS FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
