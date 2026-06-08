// Tests the extension bridge + page_* tool gating (deterministic; the live
// extension/DOM side is exercised manually in Chrome).
import "./test-config-setup";
import { extensionConnected, setExtension, resolveCommand, sendCommand } from "./src/extbridge";
import { executeTool } from "./src/tools/executor";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// no extension → page tools say so, don't hang
check("not connected initially", !extensionConnected());
let r = await executeTool("page_read", {});
check("page_read without extension is rejected cleanly", r.includes("No browser extension connected"), r);
r = await executeTool("page_click", { target: "Login" });
check("page_click without extension is rejected cleanly", r.includes("No browser extension connected"), r);

// simulate an extension: capture outgoing commands, auto-reply
const outbox: any[] = [];
setExtension((obj) => {
  outbox.push(obj);
  // emulate the content script replying after executing the command
  setTimeout(() => {
    if (obj.action === "read") resolveCommand(obj.id, { title: "Cars", url: "http://x", text: "Car A $5000\nCar B $3000", elements: [{ tag: "a", text: "Car B", href: "/b" }] });
    if (obj.action === "click") resolveCommand(obj.id, { ok: true, label: "Car B" });
    if (obj.action === "find") resolveCommand(obj.id, { matches: [{ tag: "div", text: "$3000" }] });
  }, 5);
});
check("extension now reports connected", extensionConnected());

r = await executeTool("page_read", {});
check("page_read returns the page text + elements", r.includes("Car B") && r.includes("$3000"), r);
check("page_read sent a 'read' command to the extension", outbox.some(o => o.action === "read"));

r = await executeTool("page_click", { target: "Car B" });
check("page_click returns what was clicked", r.includes("clicked") && r.includes("Car B"), r);

r = await executeTool("page_find", { query: "3000" });
check("page_find returns matches", r.includes("$3000"), r);

// missing arg
r = await executeTool("page_click", {});
check("page_click requires a target", r.includes("target"), r);

// disconnect → in-flight reject, tools gated again
const slow = sendCommand("read"); // will reject on disconnect
setExtension(null);
let rejected = false; try { await slow; } catch { rejected = true; }
check("pending commands reject on disconnect", rejected);
check("gated again after disconnect", !extensionConnected());

console.log(`\n${fail === 0 ? "EXTENSION OK" : "EXTENSION FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
