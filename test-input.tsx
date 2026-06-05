// Tests for the custom PromptInput: typing, submit, up/down history recall,
// backspace, clear-line, and Ctrl+V paste (via an injected paste source).
import React, { useRef } from "react";
import { render } from "ink-testing-library";
import { PromptInput } from "./src/ui/components";
import { sanitizeForInput } from "./src/clipboard";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { fail++; console.log(`  ✗ ${l} ${e}`); }
};

// Control bytes, unambiguous.
const ESC = String.fromCharCode(27);
const UP = ESC + "[A";
const DOWN = ESC + "[B";
const BACKSPACE = String.fromCharCode(127);
const CTRL_U = String.fromCharCode(21);
const CTRL_V = String.fromCharCode(22);

const submitted: string[] = [];

function Harness({ paste }: { paste?: () => Promise<string> }) {
  const history = useRef<string[]>([]);
  return (
    <PromptInput
      color="cyan"
      placeholder="type here…"
      onSubmit={(v) => submitted.push(v)}
      history={history}
      pasteSource={paste ?? (async () => "PASTED_TEXT")}
    />
  );
}

const inst = render(<Harness />);
const last = () => inst.lastFrame() ?? "";

const run = async () => {
  check("shows placeholder when empty", /type here…/.test(last()));

  inst.stdin.write("first message");
  await sleep(40);
  check("renders typed text", /first message/.test(last()));
  inst.stdin.write("\r");
  await sleep(40);
  check("submits on enter", submitted[0] === "first message");
  check("clears after submit", /type here…/.test(last()));

  inst.stdin.write("second message");
  await sleep(40);
  inst.stdin.write("\r");
  await sleep(40);
  check("submits second entry", submitted[1] === "second message");

  inst.stdin.write(UP);
  await sleep(40);
  check("up arrow recalls last entry", /second message/.test(last()));

  inst.stdin.write(UP);
  await sleep(40);
  check("up again recalls older entry", /first message/.test(last()));

  inst.stdin.write(DOWN);
  await sleep(40);
  check("down arrow moves to newer entry", /second message/.test(last()));

  inst.stdin.write(BACKSPACE);
  await sleep(40);
  check("backspace removes the last char", last().includes("second messag") && !/second message/.test(last()));

  inst.stdin.write(CTRL_U);
  await sleep(40);
  check("ctrl+u clears the line", /type here…/.test(last()));

  inst.stdin.write(CTRL_V);
  await sleep(120);
  check("ctrl+v pastes clipboard text", /PASTED_TEXT/.test(last()), last());

  inst.stdin.write("\r");
  await sleep(40);
  check("can submit pasted text", submitted[submitted.length - 1] === "PASTED_TEXT");

  // ── sanitizeForInput: the font-corruption fix ──
  const ESCc = String.fromCharCode(27);
  check("strips bracketed-paste markers", sanitizeForInput(`${ESCc}[200~hello${ESCc}[201~`) === "hello");
  check("strips charset-select escape (the font change)", sanitizeForInput(`${ESCc}(0abc${ESCc}(B`) === "abc");
  check("strips SGR color codes", sanitizeForInput(`${ESCc}[31mred${ESCc}[0m`) === "red");
  check("strips bare control bytes", sanitizeForInput("a\x07b\x00c") === "abc");
  check("keeps newlines, converts tabs", sanitizeForInput("a\tb\nc") === "a  b\nc");
  check("leaves clean text untouched", sanitizeForInput("just normal text 123") === "just normal text 123");

  // Paste containing escapes must not render any ESC byte into the frame.
  const inst2 = render(<Harness paste={async () => `${ESCc}[200~weird${ESCc}[31m text${ESCc}[201~`} />);
  inst2.stdin.write(CTRL_V);
  await sleep(120);
  const f2 = inst2.lastFrame() ?? "";
  check("pasted escapes are stripped before render", f2.includes("weird") && f2.includes("text") && !f2.includes(ESCc + "["));
  inst2.unmount();

  inst.unmount();
  console.log(`\n${fail === 0 ? "INPUT OK" : "INPUT FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run();
