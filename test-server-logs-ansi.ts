// Server logs were storing raw ANSI escape sequences (vite/next colors, cursor
// moves, spinner redraws). They rendered as garbage in the web UI ("[33m[1m"),
// wasted tokens for the model, and could break URL/error detection. stripAnsi
// removes them at capture; collapseCarriageReturns resolves in-place \r redraws.
import { stripAnsi, collapseCarriageReturns } from "./src/proc";

const E = String.fromCharCode(27); // ESC
let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── stripAnsi: realistic dev-server output (matches the user's screenshot) ──
const sgr = `${E}[33m${E}[1m - The 'content' option in your Tailwind config is missing${E}[39m${E}[22m`;
check("strips SGR color codes", stripAnsi(sgr) === " - The 'content' option in your Tailwind config is missing", JSON.stringify(stripAnsi(sgr)));

const url = `${E}[36mhttp://localhost:${E}[1m5174${E}[22m${E}[39m`;
check("preserves URL + port (no over-match)", stripAnsi(url) === "http://localhost:5174", JSON.stringify(stripAnsi(url)));

const vite = `${E}[32m${E}[1mVITE${E}[22m v5.4.21${E}[39m  ${E}[2mready in ${E}[1m388${E}[22m${E}[0m ms`;
check("keeps version + 'ready in 388 ms'", stripAnsi(vite) === "VITE v5.4.21  ready in 388 ms", JSON.stringify(stripAnsi(vite)));

const clear = `${E}[2K${E}[1Gbuilding...`;
check("strips clear-line / cursor-move CSI", stripAnsi(clear) === "building...", JSON.stringify(stripAnsi(clear)));

check("plain text untouched", stripAnsi("Port 5173 is in use, trying another one...") === "Port 5173 is in use, trying another one...");
check("digits/letters after a code are not eaten", stripAnsi(`${E}[1m200${E}[0m OK GET /index.html`) === "200 OK GET /index.html", JSON.stringify(stripAnsi(`${E}[1m200${E}[0m OK GET /index.html`)));

// ── collapseCarriageReturns: spinner / progress overwrites ──
check("keeps only the final \\r segment", collapseCarriageReturns("building...\rbuilding...\r✓ done") === "✓ done");
check("line without \\r is unchanged", collapseCarriageReturns("plain line") === "plain line");

console.log(`\n${fail === 0 ? "SERVER-LOGS-ANSI OK" : "SERVER-LOGS-ANSI FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
