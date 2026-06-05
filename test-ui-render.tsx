import "./test-config-setup";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "./src/ui/App";
import { saveConfig } from "./src/config";
import { tmpdir } from "os";
import { basename } from "path";

const testCwd = tmpdir();

// Give the UI a clean, known config so the frame is deterministic.
saveConfig({
  model: "qwen3:latest",
  baseUrl: "http://localhost:11434/v1",
  cwd: testCwd,
});

const inst = render(<App />);
// Static output (banner) + dynamic frame together.
const frame = (inst.lastFrame() ?? "");
const all = frame; // ink-testing-library merges static into frames
console.log(frame);
console.log("\n──────── checks ────────");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

check("shows model name", all.includes("qwen3:latest"));
// The banner shows some portion of the cwd path (may be truncated): check for
// either the full path or its base name — whichever appears in the rendered frame.
check("shows cwd", all.includes(testCwd) || all.includes(basename(testCwd)));
check("shows ready status", all.includes("ready"));
check("shows input placeholder", all.includes("message") || all.includes("/help"));
check("shows token counter", all.includes("%"));

inst.unmount();
console.log(`\n${fail === 0 ? "UI RENDER OK" : "UI RENDER FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
