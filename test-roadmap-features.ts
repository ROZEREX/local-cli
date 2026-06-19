// Tests the roadmap features: undo history, fuzzy edit (similarity fallback),
// hunk selection, project memory, task list, workspace index + keyword search,
// and server error streaming (drainServerErrors).
import "./test-config-setup";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveConfig } from "./src/config";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

const dir = mkdtempSync(join(tmpdir(), "lcli-roadmap-"));
// Point the CLI at the temp project, and at a dead Ollama so embedding probes
// fail fast and search falls back to keywords deterministically.
saveConfig({ cwd: dir, baseUrl: "http://127.0.0.1:1/v1" });

const run = async () => {
  // ── undo system ─────────────────────────────────────────────────────────────
  console.log("undo system:");
  const { writeFile, editFile, deleteFile } = await import("./src/tools/executor");
  const { undoLast, listHistory, describeHistory } = await import("./src/history");

  writeFile({ path: "a.txt", content: "one\ntwo\nthree\n" });
  check("write_file records history", listHistory().length === 1);
  editFile({ path: "a.txt", old_string: "two", new_string: "TWO" });
  check("edit applied", readFileSync(join(dir, "a.txt"), "utf-8").includes("TWO"));
  check("edit_file records history", listHistory().length === 2);

  let r = undoLast(1);
  check("undo edit restores content", readFileSync(join(dir, "a.txt"), "utf-8").includes("two\n") && r.includes("restored"));
  r = undoLast(1);
  check("undo create deletes the file", !existsSync(join(dir, "a.txt")) && r.includes("removed"));

  writeFile({ path: "b.txt", content: "hello\n" });
  deleteFile({ path: "b.txt" });
  r = undoLast(1);
  check("undo delete restores the file", existsSync(join(dir, "b.txt")) && readFileSync(join(dir, "b.txt"), "utf-8") === "hello\n");
  check("describeHistory lists entries", describeHistory().includes("b.txt"));

  // ── fuzzy edit (similarity fallback) ────────────────────────────────────────
  console.log("fuzzy edit:");
  writeFile({ path: "c.js", content: `function add(a, b) {\n  // sums two numbers together\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\n` });
  // Slightly misquoted search (different comment wording) → similarity stage.
  const fuzzyRes = editFile({
    path: "c.js",
    old_string: `function add(a, b) {\n  // sums two number together\n  return a + b;\n}`,
    new_string: `function add(a, b) {\n  return a + b; // tight\n}`,
  });
  check("fuzzy similarity edit applies", fuzzyRes.startsWith("Edited") && readFileSync(join(dir, "c.js"), "utf-8").includes("// tight"), fuzzyRes);
  const noMatch = editFile({ path: "c.js", old_string: "completely unrelated text that exists nowhere at all", new_string: "x" });
  check("garbage search still fails", noMatch.startsWith("Error"), noMatch);

  // ── hunks ───────────────────────────────────────────────────────────────────
  console.log("hunk selection:");
  const { computeHunks, applyHunks } = await import("./src/hunks");
  const oldT = "a\nb\nc\nd\ne";
  const newT = "a\nB\nc\nd\nE";
  const hunks = computeHunks(oldT, newT);
  check("two separate hunks detected", hunks.length === 2, `got ${hunks.length}`);
  const partial = applyHunks(oldT, newT, new Set([0]));
  check("applying only hunk 0", partial === "a\nB\nc\nd\ne", JSON.stringify(partial));
  const all = applyHunks(oldT, newT, new Set([0, 1]));
  check("applying all hunks = new text", all === newT);
  const none = applyHunks(oldT, newT, new Set());
  check("applying no hunks = old text", none === oldT);

  // ── project memory ──────────────────────────────────────────────────────────
  console.log("project memory:");
  const { addMemory, readMemory, forgetMemory, memoryPromptSection } = await import("./src/memory");
  const m1 = addMemory("Backend uses NestJS");
  check("memory add", m1.added === 1 && readMemory().includes("- Backend uses NestJS"));
  const m2 = addMemory("- Backend uses NestJS");
  check("memory dedupes", m2.added === 0 && m2.skipped === 1);
  addMemory("Prefer Zod over Joi");
  check("memory prompt section injects facts", memoryPromptSection().includes("Zod"));
  check("memory forget", forgetMemory("zod") === 1 && !readMemory().includes("Zod"));

  // ── tasks ───────────────────────────────────────────────────────────────────
  console.log("task list:");
  const { addTask, completeTask, readTasks, removeDoneTasks, tasksPromptSection } = await import("./src/tasks");
  addTask("Fix login bug");
  addTask("Add OAuth support");
  check("tasks added", readTasks().length === 2);
  const done = completeTask("login");
  check("complete by text", done.ok && readTasks()[0]!.done);
  check("complete by index", completeTask(2).ok && readTasks()[1]!.done);
  check("prompt section empty when no open tasks", tasksPromptSection() === "");
  addTask("Pending thing");
  check("prompt section lists open tasks", tasksPromptSection().includes("Pending thing"));
  check("clean removes done", removeDoneTasks() === 2 && readTasks().length === 1);

  // ── workspace index + keyword search ────────────────────────────────────────
  console.log("index + search:");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "auth.ts"), `export function generateJwtToken(user: string) {\n  return sign(user);\n}\nexport class AuthService {}\napp.post("/api/login", handler);\n`, "utf-8");
  writeFileSync(join(dir, "src", "math.ts"), `export function sum(a: number, b: number) { return a + b; }\n`, "utf-8");
  const { buildIndex } = await import("./src/indexer");
  const idx = await buildIndex();
  check("index finds symbols", idx.symbols.some(s => s.name === "generateJwtToken") && idx.symbols.some(s => s.name === "AuthService"));
  check("index finds endpoints", idx.symbols.some(s => s.kind === "endpoint" && s.name.includes("/api/login")));
  check("index persisted", existsSync(join(dir, ".local-cli", "index.json")));

  const { searchCode } = await import("./src/search");
  const sr = await searchCode("jwt token generation");
  check("keyword search finds auth.ts", sr.hits.some(h => h.file.includes("auth.ts")), JSON.stringify(sr.hits.map(h => h.file)));
  const sr2 = await searchCode("sum two numbers");
  check("search ranks math.ts for sum", sr2.hits.some(h => h.file.includes("math.ts")));

  // ── server error streaming ──────────────────────────────────────────────────
  console.log("server error streaming:");
  const { startServer, drainServerErrors, stopAllServers, waitForStartup } = await import("./src/proc");
  const proc = startServer(`bun -e "console.error('TypeError: boom is not a function'); console.log('ok line')"`);
  await waitForStartup(proc, 6000);
  await new Promise(r => setTimeout(r, 300));
  const errs = drainServerErrors();
  check("error line detected and drained", errs.length === 1 && errs[0]!.lines.some(l => l.includes("TypeError")), JSON.stringify(errs));
  check("drain clears the queue", drainServerErrors().length === 0);
  stopAllServers();

  // ── theme presets ───────────────────────────────────────────────────────────
  console.log("themes:");
  const { theme, applyTheme, toolColor } = await import("./src/ui/theme");
  const before = theme.color.primary;
  check("applyTheme switches palette", applyTheme("light") && theme.color.primary !== before);
  check("toolColor follows the palette", toolColor.edit_file === theme.color.primary);
  check("unknown theme rejected", !applyTheme("nope"));
  applyTheme("tokyo");

  // ── model fit warning (VRAM heads-up on switch) ─────────────────────────────
  console.log("model fit warning:");
  const { modelFitWarning } = await import("./src/sysinfo");
  // Force a known budget so the test is deterministic regardless of the host GPU.
  const sys = await import("./src/sysinfo");
  // cachedSystemInfo memoizes; prime it by stubbing via the real call isn't easy,
  // so test the pure thresholds through the exported function with a fake budget
  // by temporarily overriding cachedSystemInfo's cache through systemInfo shape.
  // Instead, assert behavior relative to the real detected budget:
  const info = sys.systemInfo();
  const budgetBytes = info.budgetGB * 1e9;
  const tooBig = modelFitWarning(Math.round(budgetBytes * 1.5), 262144);
  check("warns when weights exceed the budget", !!tooBig && /won't fully fit/.test(tooBig!), String(tooBig));
  check("big-context note included when oversized", !!tooBig && /context/.test(tooBig!));
  const fits = modelFitWarning(Math.round(budgetBytes * 0.3), 8192);
  check("no warning when it comfortably fits", fits === null, String(fits));
  check("no warning without a size", modelFitWarning(undefined, 262144) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
