import { lineDiff, buildDiffView, compactDiff } from "./src/diff";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};

// Basic add/del/ctx
let d = lineDiff("a\nb\nc", "a\nB\nc");
check("unchanged lines are ctx", d.filter(l => l.type === "ctx").length === 2);
check("changed line shows as del+add", d.some(l => l.type === "del" && l.text === "b") && d.some(l => l.type === "add" && l.text === "B"));

// Pure additions (new file)
d = lineDiff("", "x\ny");
check("new content is all adds", d.filter(l => l.type === "add").length === 2 && d.every(l => l.type !== "del" || l.text === ""));

// Pure deletions
d = lineDiff("x\ny\nz", "x\nz");
check("removed middle line is a del", d.some(l => l.type === "del" && l.text === "y"));

// buildDiffView counts
const v = buildDiffView("one\ntwo\nthree", "one\nTWO\nthree\nfour");
check("counts additions", v.added === 2, `added=${v.added}`);     // TWO, four
check("counts removals", v.removed === 1, `removed=${v.removed}`); // two

// compactDiff collapses long context
const many: any[] = [];
for (let i = 0; i < 50; i++) many.push({ type: "ctx", text: `line${i}` });
many.push({ type: "add", text: "NEW" });
const c = compactDiff(many, 2, 30);
check("compactDiff drops far-away context", c.lines.length < many.length);
check("compactDiff keeps the change", c.lines.some(l => l.type === "add" && l.text === "NEW"));
check("compactDiff inserts an ellipsis marker", c.lines.some(l => l.text === "⋯"));

console.log(`\n${fail === 0 ? "DIFF OK" : "DIFF FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
