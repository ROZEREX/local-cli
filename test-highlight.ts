import { highlightToLines } from "./src/ui/highlight";
import { theme } from "./src/ui/theme";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const colorsIn = (lines: ReturnType<typeof highlightToLines>) =>
  lines.flat().map(s => ({ t: s.text, c: s.color }));

// JS/TS
let spans = colorsIn(highlightToLines(`const x = "hi"; // note`, "ts"));
check("keyword 'const' colored", spans.some(s => s.t === "const" && s.c === theme.syntax.keyword));
check("string colored", spans.some(s => /"hi"/.test(s.t) && s.c === theme.syntax.string));
check("comment colored", spans.some(s => s.t.includes("// note") && s.c === theme.syntax.comment));
check("number colored", colorsIn(highlightToLines("let n = 42;", "js")).some(s => s.t === "42" && s.c === theme.syntax.number));
check("function call colored", colorsIn(highlightToLines("doThing(1)", "js")).some(s => s.t === "doThing" && s.c === theme.syntax.func));
check("boolean constant colored", colorsIn(highlightToLines("a = true", "js")).some(s => s.t === "true" && s.c === theme.syntax.constant));

// multi-line preserved
const ml = highlightToLines("line1\nline2\nline3", "txt");
check("line count preserved", ml.length === 3);

// HTML tags + attrs, embedded script highlighted
spans = colorsIn(highlightToLines(`<div class="t"><script>const y = 1;</script></div>`, "html"));
check("html tag colored", spans.some(s => s.t === "div" && s.c === theme.syntax.tag));
check("html attr colored", spans.some(s => s.t === "class" && s.c === theme.syntax.attr));
check("embedded <script> JS highlighted", spans.some(s => s.t === "const" && s.c === theme.syntax.keyword));

// CSS
spans = colorsIn(highlightToLines("body { color: red; }", "css"));
check("css property colored", spans.some(s => s.t === "color" && s.c === theme.syntax.property));

// no purple anywhere in the palette
const allColors = Object.values(theme.syntax);
check("palette has no purple-ish hues", !allColors.some(c => /^#(b|c)[0-9a-f]9af/i.test(c)) , allColors.join(","));

console.log(`\n${fail === 0 ? "HIGHLIGHT OK" : "HIGHLIGHT FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
