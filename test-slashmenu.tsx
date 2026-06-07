// Tests for the slash-command menu in PromptInput: it appears while typing a
// command name, filters as you type, navigates with arrows, completes with tab,
// runs with enter, and closes with esc.
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { PromptInput } from "./src/ui/components";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};

const ESC = String.fromCharCode(27);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const TAB = "\t";

const COMMANDS = [
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Pick a model" },
  { name: "models", description: "List installed models" },
  { name: "modelinfo", description: "Full model details" },
  { name: "learn", description: "Learn your coding style" },
  { name: "servers", description: "List background servers" },
];

const submitted: string[] = [];

function Harness() {
  const history = useRef<string[]>([]);
  return (
    <PromptInput
      color="cyan"
      placeholder="message, or /help…"
      onSubmit={(v) => submitted.push(v)}
      history={history}
      commands={COMMANDS}
    />
  );
}

const inst = render(<Harness />);
const last = () => inst.lastFrame() ?? "";

const run = async () => {
  check("no menu before any slash", !last().includes("commands"));

  // Typing "/" opens the menu with all commands.
  inst.stdin.write("/");
  await sleep(40);
  check("slash opens the command menu", last().includes("commands"), last());
  check("menu lists /help", last().includes("/help"));
  check("menu lists /servers", last().includes("/servers"));

  // Typing narrows it: "model" matches model/models/modelinfo but not help.
  inst.stdin.write("model");
  await sleep(40);
  check("filters to matching commands", last().includes("/model") && last().includes("/modelinfo"), last());
  check("filters OUT non-matches", !last().includes("/help"), last());

  // Tab completes the highlighted command (first = /model) into the input.
  inst.stdin.write(TAB);
  await sleep(40);
  check("tab completes into the input with a trailing space", /\/model\s/.test(last()), last());
  // After completion (space present) the menu closes.
  check("menu closes after completion", !last().includes("↑↓ move"), last());

  // Clear and try arrow nav + enter-to-run.
  inst.stdin.write(String.fromCharCode(21)); // ctrl+u clears
  await sleep(40);
  inst.stdin.write("/model");
  await sleep(40);
  inst.stdin.write(DOWN); // move to /models
  await sleep(40);
  inst.stdin.write(DOWN); // move to /modelinfo
  await sleep(40);
  inst.stdin.write("\r"); // run highlighted
  await sleep(40);
  check("enter runs the highlighted command", submitted[submitted.length - 1] === "/modelinfo", JSON.stringify(submitted));
  check("input clears after running", last().includes("message, or"));

  // Esc closes the menu without submitting.
  inst.stdin.write("/lea");
  await sleep(40);
  check("menu re-opens on new slash text", last().includes("/learn"));
  inst.stdin.write(ESC);
  await sleep(40);
  check("esc closes the menu", !last().includes("↑↓ move"), last());
  check("text remains after esc", last().includes("/lea"), last());

  inst.unmount();
  console.log(`\n${fail === 0 ? "SLASHMENU OK" : "SLASHMENU FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
