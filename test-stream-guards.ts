// Tests for RepetitionGuard (stops degenerate repeat loops) and HarmonyStripper
// (removes <|channel|>… markup that models like gemma leak into content).
import "./test-config-setup";
import { RepetitionGuard, HarmonyStripper } from "./src/think";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// ── RepetitionGuard ──
const line = "I noticed some minor syntax errors in Dashboard.tsx and tried to fix them.\n";
let g = new RepetitionGuard();
let tripped = false;
for (let i = 0; i < 5; i++) tripped = g.push(line);
check("does not trip below the threshold", !tripped);
tripped = g.push(line); // 6th
check("trips when a long line repeats threshold times", tripped);
check("stays tripped", g.push("anything") === true);

// short lines don't trip (avoid false positives on '}', 'return', etc.)
g = new RepetitionGuard();
let t2 = false;
for (let i = 0; i < 20; i++) t2 = g.push("}\n");
check("short repeated lines do NOT trip", !t2);

// normal varied text doesn't trip
g = new RepetitionGuard();
let t3 = false;
for (let i = 0; i < 30; i++) t3 = g.push(`line number ${i} with unique content here\n`);
check("varied lines do NOT trip", !t3);

// repetition split across chunk boundaries still trips
g = new RepetitionGuard();
const big = line.repeat(6);
let t4 = false;
for (let i = 0; i < big.length; i += 3) t4 = g.push(big.slice(i, i + 3)) || t4;
check("trips even when fed in tiny chunks", t4);

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
