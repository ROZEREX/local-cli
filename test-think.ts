import { ThinkSplitter } from "./src/think";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

// Feed a full message split into arbitrary chunks, collect answer vs think text.
function feed(chunks: string[]): { answer: string; think: string } {
  const s = new ThinkSplitter();
  let answer = "", think = "";
  for (const c of chunks) {
    for (const seg of s.push(c)) (seg.think ? (think += seg.text) : (answer += seg.text));
  }
  for (const seg of s.flush()) (seg.think ? (think += seg.text) : (answer += seg.text));
  return { answer, think };
}

// 1. Simple think block
let r = feed(["<think>reasoning here</think>The answer"]);
check("basic split", r.answer === "The answer" && r.think === "reasoning here", JSON.stringify(r));

// 2. Tag split across chunk boundary
r = feed(["<thi", "nk>secret</thi", "nk>visible"]);
check("tag spans chunks", r.answer === "visible" && r.think === "secret", JSON.stringify(r));

// 3. No think tags at all
r = feed(["just plain text ", "no tags"]);
check("no tags passthrough", r.answer === "just plain text no tags" && r.think === "", JSON.stringify(r));

// 4. Closing tag split at the very last char
r = feed(["<think>abc</think", ">done"]);
check("closing tag boundary", r.answer === "done" && r.think === "abc", JSON.stringify(r));

// 5. A lone '<' that is not a tag must pass through
r = feed(["value < 10 is true"]);
check("lone less-than passes", r.answer === "value < 10 is true" && r.think === "", JSON.stringify(r));

// 6. Per-character streaming (worst case)
const msg = "<think>deep thought</think>final";
r = feed(msg.split(""));
check("char-by-char streaming", r.answer === "final" && r.think === "deep thought", JSON.stringify(r));

// 7. Content before think block
r = feed(["Hello <think>x</think> world"]);
check("text around think", r.answer === "Hello  world" && r.think === "x", JSON.stringify(r));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
