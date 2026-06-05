// Tests the hardened edit_file (whitespace-tolerant / gutter / CRLF) and the
// lenient tool-call parser (single quotes, path aliases, <path> child tag).
import "./test-config-setup";
import { editFile } from "./src/tools/executor";
import { parseToolCalls } from "./src/toolparse";
import { saveConfig } from "./src/config";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const dir = mkdtempSync(join(tmpdir(), "lcli-edit-"));
saveConfig({ cwd: dir });
const f = join(dir, "t.js");
const writeF = (s: string) => writeFileSync(f, s, "utf-8");
const readF = () => readFileSync(f, "utf-8");

// 1. exact full-line
writeF("const a = 1;\nconst b = 2;\n");
editFile({ path: "t.js", old_string: "const b = 2;", new_string: "const b = 3;" });
check("exact match replaces", readF().includes("const b = 3;"));

// 2. partial-line (substring within a line)
writeF("call(foo, bar);\n");
editFile({ path: "t.js", old_string: "foo", new_string: "baz" });
check("partial-line substring replace", readF().includes("call(baz, bar);"));

// 3. indentation drift — search has different leading whitespace
writeF("function x() {\n        return 42;\n}\n");
let r = editFile({ path: "t.js", old_string: "  return 42;", new_string: "  return 99;" });
check("indentation-tolerant match", readF().includes("return 99;"), r);

// 4. trailing whitespace in file
writeF("let z = 1;   \nlet y = 2;\n");
editFile({ path: "t.js", old_string: "let z = 1;", new_string: "let z = 10;" });
check("trailing-whitespace tolerant", readF().includes("let z = 10;"));

// 5. CRLF file, LF search — and CRLF preserved
writeF("alpha\r\nbeta\r\ngamma\r\n");
editFile({ path: "t.js", old_string: "beta", new_string: "BETA" });
check("CRLF file matched with LF search", readF().includes("BETA"));
check("CRLF line endings preserved", readF().includes("\r\n"));

// 6. line-number gutter copied from read_file output
writeF("showAlert(false);\nsetLoading(true);\n");
editFile({ path: "t.js", old_string: "20\tshowAlert(false);\n21\tsetLoading(true);", new_string: "showAlert(true);\nsetLoading(false);" });
check("strips read_file gutter from search", readF().includes("showAlert(true);") && readF().includes("setLoading(false);"), readF());

// 7. ambiguous without replace_all → error
writeF("x();\nx();\n");
r = editFile({ path: "t.js", old_string: "x();", new_string: "y();" });
check("ambiguous match errors", r.includes("matches 2"), r);

// 8. genuinely-not-found → helpful error
writeF("hello world\n");
r = editFile({ path: "t.js", old_string: "nonexistent code", new_string: "z" });
check("not-found gives a clear error", /not found/.test(r), r);

// ── parser leniency ──
check("single-quoted path", parseToolCalls(`<edit_file path='src/a.js'><search>x</search><replace>y</replace></edit_file>`)[0]?.arguments.path === "src/a.js");
check("unquoted path", parseToolCalls(`<write_file path=index.html>hi</write_file>`)[0]?.arguments.path === "index.html");
check("alias file= → path", parseToolCalls(`<write_file file="y.txt">hi</write_file>`)[0]?.arguments.path === "y.txt");
check("<path> child tag", parseToolCalls(`<read_file><path>z.ts</path></read_file>`)[0]?.arguments.path === "z.ts");
check("<content> child tag", parseToolCalls(`<write_file path="a"><content>BODY</content></write_file>`)[0]?.arguments.content === "BODY");
check("new_string alias in edit", (() => { const e = parseToolCalls(`<edit_file path="a"><search>o</search><new_string>n</new_string></edit_file>`)[0]; return e?.arguments.old_string === "o" && e.arguments.new_string === "n"; })());

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "EDIT OK" : "EDIT FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
