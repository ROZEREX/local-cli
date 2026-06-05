// UI test for the FileBrowser: navigate, select a file, confirm.
import React from "react";
import { render } from "ink-testing-library";
import { FileBrowser } from "./src/ui/components";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const root = mkdtempSync(join(tmpdir(), "lcli-fb-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "index.js"), "x");
writeFileSync(join(root, "readme.md"), "y");

let confirmed: string[] | null = null;
const inst = render(<FileBrowser startDir={root} onConfirm={(p) => { confirmed = p; }} onCancel={() => {}} />);
const last = () => inst.lastFrame() ?? "";
const DOWN = String.fromCharCode(27) + "[B";

const run = async () => {
  await sleep(50);
  check("shows the start dir", last().includes(root));
  check("lists files", last().includes("index.js") && last().includes("readme.md"));
  check("shows the add hint with count 0", /add \(0\)/.test(last()));

  // entries: ['..','src','index.js','readme.md'] → index.js at idx 2
  inst.stdin.write(DOWN); await sleep(30);
  inst.stdin.write(DOWN); await sleep(30);
  inst.stdin.write(" "); await sleep(40); // select index.js
  check("selecting updates the count", /add \(1\)/.test(last()), last());

  inst.stdin.write("a"); await sleep(40); // confirm
  check("confirm returns the selected file", !!confirmed && confirmed.length === 1 && confirmed[0]!.endsWith("index.js"), JSON.stringify(confirmed));

  inst.unmount();
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "FILES UI OK" : "FILES UI FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
