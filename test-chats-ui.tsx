// UI test for ChatBrowser: render, switch, new, delete.
import React from "react";
import { render } from "ink-testing-library";
import { ChatBrowser } from "./src/ui/components";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const now = Date.now();
const sessions: any = [
  { id: "s1", title: "first chat", model: "qwen2.5-coder:latest", cwd: "x", createdAt: now, updatedAt: now - 60000, messageCount: 4 },
  { id: "s2", title: "second chat", model: "gemma4:latest", cwd: "x", createdAt: now, updatedAt: now - 120000, messageCount: 9 },
];
let switched: string | null = null, newed = false, deleted: string | null = null;
const inst = render(<ChatBrowser sessions={sessions} activeId="s2" onSwitch={(id) => { switched = id; }} onNew={() => { newed = true; }} onDelete={(id) => { deleted = id; }} onCancel={() => {}} />);
const last = () => inst.lastFrame() ?? "";
const DOWN = String.fromCharCode(27) + "[B";

const run = async () => {
  await sleep(40);
  check("lists 'new chat' entry", /new chat/.test(last()));
  check("shows chat titles + counts", last().includes("first chat") && /4 msg/.test(last()));
  check("marks the active chat", last().includes("●"));

  inst.stdin.write(DOWN); await sleep(30);     // → first chat
  inst.stdin.write("\r"); await sleep(30);     // switch
  check("enter on a chat switches to it", switched === "s1", String(switched));

  inst.stdin.write("n"); await sleep(30);
  check("'n' starts a new chat", newed);

  inst.stdin.write("d"); await sleep(30);      // delete the highlighted chat (still s1)
  check("'d' deletes the highlighted chat", deleted === "s1", String(deleted));

  inst.unmount();
  console.log(`\n${fail === 0 ? "CHATS UI OK" : "CHATS UI FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
