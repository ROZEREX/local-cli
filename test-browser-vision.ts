// Deterministic tests for the browser-control + vision tools (validation, browser
// detection, arg aliases, registration). Live CDP/vision needs a real browser and
// a vision model, so that's a manual/live check, not part of the suite.
import "./test-config-setup";
import { executeTool } from "./src/tools/executor";
import { findBrowser } from "./src/browser";
import { TOOL_DEFINITIONS } from "./src/tools/definitions";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// registration
const names = TOOL_DEFINITIONS.map(t => t.function.name);
for (const n of ["browser_open", "browser_read", "browser_click", "browser_screenshot", "browser_close", "screenshot"]) {
  check(`${n} is a registered tool`, names.includes(n));
}

// validation
let r = await executeTool("browser_open", {});
check("browser_open requires a url", r.includes("url is required"), r);
r = await executeTool("browser_click", {});
check("browser_click requires a target", r.includes("selector or visible text"), r);

// arg aliases (address -> url) — should get past validation and try to open
r = await executeTool("browser_open", { address: "http://localhost:65530" });
check("browser_open accepts the 'address' alias", !r.includes("url is required"), r);

// findBrowser returns a path or null without throwing
let detected: string | null = null;
let threw = false;
try { detected = findBrowser(); } catch { threw = true; }
check("findBrowser doesn't throw", !threw);
check("findBrowser returns a string path or null", detected === null || typeof detected === "string", String(detected));
console.log(`    (browser detected: ${detected ?? "none on this machine"})`);

console.log(`\n${fail === 0 ? "BROWSER-VISION OK" : "BROWSER-VISION FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
