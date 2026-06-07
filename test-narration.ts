// Tests the NarrationFilter: hide tool calls a model PRINTS as ```json blocks,
// but keep genuine prose and real code fences. Also covers chunk boundaries.
import "./test-config-setup";
import { NarrationFilter, isToolCallText } from "./src/toolparse";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Feed text to a filter in arbitrary chunk sizes and collect what it emits.
function runFilter(text: string, chunkSize: number): string {
  const f = new NarrationFilter();
  let out = "";
  for (let i = 0; i < text.length; i += chunkSize) out += f.push(text.slice(i, i + chunkSize));
  out += f.flush();
  return out;
}

// ── isToolCallText ──
check("recognizes a known-tool JSON call", isToolCallText('{"name":"read_file","arguments":{"path":"a"}}'));
check("recognizes an aliased name (read_dir→list_dir)", isToolCallText('{"name":"read_dir","arguments":{"path":"."}}'));
check("rejects ordinary JSON", !isToolCallText('{"name":"John","age":30}'));
check("rejects prose", !isToolCallText("just some text"));

// ── narrated tool call gets hidden ──
const narrated = 'Let me look around.\n```json\n{\n  "name": "read_dir",\n  "arguments": { "path": "." }\n}\n```\n';
for (const cs of [1, 3, 7, 1000]) {
  const out = runFilter(narrated, cs);
  check(`hides narrated tool call (chunk=${cs})`, out.includes("Let me look around.") && !out.includes('"name"') && !out.includes("```"), JSON.stringify(out));
}

// ── real code fence is preserved ──
const realCode = "Here is the helper:\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\nThat's it.";
for (const cs of [1, 5, 1000]) {
  const out = runFilter(realCode, cs);
  check(`keeps a real code block (chunk=${cs})`, out.includes("function add") && out.includes("```") && out.includes("That's it."), JSON.stringify(out));
}

// ── plain prose passes through untouched ──
check("passes prose unchanged", runFilter("no fences here, just words.", 4) === "no fences here, just words.");

// ── mixed: prose + narrated call + prose ──
const mixed = "First.\n```json\n{\"name\":\"list_dir\",\"arguments\":{\"path\":\".\"}}\n```\nSecond.";
const mixedOut = runFilter(mixed, 6);
check("keeps surrounding prose, drops the call", mixedOut.includes("First.") && mixedOut.includes("Second.") && !mixedOut.includes("list_dir"), JSON.stringify(mixedOut));

console.log(`\n${fail === 0 ? "NARRATION OK" : "NARRATION FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
