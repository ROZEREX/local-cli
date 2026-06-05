// UI test for the new interactive features: shift+tab plan-mode toggle and the
// /model arrow-key picker.
import "./test-config-setup";
import React from "react";
import { render } from "ink-testing-library";
import { saveConfig } from "./src/config";
import { App } from "./src/ui/App";

saveConfig({
  model: "qwen3:latest",
  models: ["qwen3:latest", "qwen2.5-coder:latest"],
  baseUrl: "http://127.0.0.1:9/v1", // closed port → warm-up & model-list fetch fail fast (hermetic)
  cwd: process.cwd(),
});

const inst = render(<App />);
const frames = () => inst.frames.join("\n");
const last = () => inst.lastFrame() ?? "";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000) {
  const s = Date.now();
  while (Date.now() - s < ms) { if (pred()) return true; await sleep(40); }
  return false;
}

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};

const SHIFT_TAB = "[Z";
const DOWN = "[B";

const run = async () => {
  // shift+tab → plan mode badge (retry to dodge the input-subscription race)
  let planOn = false;
  for (let i = 0; i < 15 && !planOn; i++) { inst.stdin.write(SHIFT_TAB); planOn = await waitFor(() => /PLAN/.test(last()), 400); }
  check("shift+tab enables PLAN mode badge", planOn);

  // shift+tab again → back to normal
  let planOff = false;
  for (let i = 0; i < 15 && !planOff; i++) { inst.stdin.write(SHIFT_TAB); planOff = await waitFor(() => !/PLAN/.test(last()), 400); }
  check("shift+tab toggles plan mode back off", planOff);

  // /model opens the picker
  inst.stdin.write("/model");
  await sleep(100);
  inst.stdin.write("\r");
  const pickerOpen = await waitFor(() => /Select a model/.test(last()));
  check("/model opens the model picker", pickerOpen);

  // Move to the last item first (down is clamped, so extra presses are safe),
  // then commit with enter — keeps enter from selecting index 0 in a race.
  for (let i = 0; i < 6; i++) { inst.stdin.write(DOWN); await sleep(60); }
  for (let i = 0; i < 20; i++) {
    if (/Model set to qwen2\.5-coder/.test(frames())) break;
    inst.stdin.write("\r");
    await sleep(100);
  }
  check("selecting from picker switches model", /Model set to qwen2\.5-coder/.test(frames()));
  check("status bar reflects the new model", await waitFor(() => /qwen2\.5-coder/.test(last())));

  inst.unmount();
  console.log(`\n${fail === 0 ? "UI FEATURES OK" : "UI FEATURES FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
