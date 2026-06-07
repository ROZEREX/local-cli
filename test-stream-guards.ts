// Tests for RepetitionGuard (stops degenerate repeat loops) and HarmonyStripper
// (removes <|channel|>… markup that models like gemma leak into content).
import "./test-config-setup";
import { RepetitionGuard, HarmonyStripper } from "./src/think";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── RepetitionGuard: only a genuine back-to-back loop trips it ──
const para = "I noticed some minor syntax errors in Dashboard.tsx and tried to fix them but failed due to a mismatch.\nI will re-read the file and apply the correct fixes for those specific lines.\n";

// 3 consecutive copies is NOT enough (a model may legitimately restate once or twice)
let g = new RepetitionGuard();
let tripped = false;
for (let i = 0; i < 3; i++) tripped = g.push(para);
check("does not trip on a few repeats", !tripped);

// a clear runaway loop (many consecutive verbatim copies) DOES trip
g = new RepetitionGuard();
tripped = false;
for (let i = 0; i < 8 && !tripped; i++) tripped = g.push(para);
check("trips on a runaway verbatim loop", tripped);
check("stays tripped", g.push("anything") === true);

// a long, VARIED answer that happens to reuse a phrase a few times does NOT trip
g = new RepetitionGuard();
let t2 = false;
for (let i = 0; i < 40; i++) {
  t2 = g.push(`Step ${i}: let me handle the configuration and entry points for this part of the project.\n`) || t2;
}
check("long varied answer does NOT trip (no false positive)", !t2);

// reusing the SAME sentence occasionally (not back-to-back) does NOT trip
g = new RepetitionGuard();
let t3 = false;
for (let i = 0; i < 10; i++) {
  t3 = g.push("Now I will create the next file for the application.\n") || t3;   // same line...
  t3 = g.push(`Working on module number ${i} with its own distinct logic here.\n`) || t3; // ...but interleaved
}
check("interleaved (non-consecutive) repeats do NOT trip", !t3);

// short repeated lines (}, return) never trip
g = new RepetitionGuard();
let t4 = false;
for (let i = 0; i < 30; i++) t4 = g.push("}\n") || t4;
check("short repeated lines do NOT trip", !t4);

// a runaway loop split across tiny chunk boundaries still trips
g = new RepetitionGuard();
const big = para.repeat(8);
let t5 = false;
for (let i = 0; i < big.length; i += 3) t5 = g.push(big.slice(i, i + 3)) || t5;
check("trips on a runaway loop fed in tiny chunks", t5);

// ── HarmonyStripper ──
function strip(text: string, chunk: number): string {
  const h = new HarmonyStripper();
  let out = "";
  for (let i = 0; i < text.length; i += chunk) out += h.push(text.slice(i, i + chunk));
  out += h.flush();
  return out;
}

const harmony = "<|channel|>thought<|message|>I should fix the import.<|end|><|start|>assistant<|channel|>final<|message|>Done.";
for (const cs of [1, 4, 1000]) {
  const out = strip(harmony, cs);
  check(`strips harmony control tokens (chunk=${cs})`, !out.includes("<|") && out.includes("I should fix the import.") && out.includes("Done."), JSON.stringify(out));
}

check("leaves ordinary text untouched", strip("just a normal answer with code `x < y`", 5) === "just a normal answer with code `x < y`");
check("keeps a lone '<' that isn't a token", strip("if a < b then", 3) === "if a < b then");

console.log(`\n${fail === 0 ? "STREAM-GUARDS OK" : "STREAM-GUARDS FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
