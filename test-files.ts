import { listDirEntries, expandSelection, readFilesAsContext } from "./src/files";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const root = mkdtempSync(join(tmpdir(), "lcli-files-"));
mkdirSync(join(root, "src"));
mkdirSync(join(root, "node_modules"));
writeFileSync(join(root, "index.js"), "console.log(1)");
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
writeFileSync(join(root, "node_modules", "junk.js"), "junk");
writeFileSync(join(root, ".hidden"), "secret");
writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));

// listDirEntries
const entries = listDirEntries(root);
check("first entry is '..'", entries[0]?.name === ".." && entries[0]?.isDir === true);
check("lists dirs before files", entries.findIndex(e => e.name === "src") < entries.findIndex(e => e.name === "index.js"));
check("ignores node_modules", !entries.some(e => e.name === "node_modules"));
check("skips hidden files", !entries.some(e => e.name === ".hidden"));
check("root (isRoot) hides '..'", listDirEntries(root, true)[0]?.name !== "..");

// expandSelection
const all = expandSelection([root]);
check("expands a dir to its files recursively", all.some(p => p.endsWith("index.js")) && all.some(p => p.endsWith("a.ts")));
check("expansion skips node_modules", !all.some(p => p.includes("node_modules")));
check("expanding a single file returns it", expandSelection([join(root, "index.js")]).length === 1);

// readFilesAsContext
const res = readFilesAsContext([join(root, "index.js"), join(root, "bin.dat")], root);
check("includes the text file with relpath", res.block.includes("index.js") && res.block.includes("console.log(1)"));
check("skips the binary file", res.included.length === 1 && res.skipped >= 1);

rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "FILES OK" : "FILES FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
