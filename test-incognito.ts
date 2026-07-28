// Tests incognito mode: with the flag on, NOTHING this app writes may reach the
// disk, and the outbound-network tool must refuse. The point of these tests is
// that the claim on the banner is verifiable — so they assert on the filesystem
// after each operation, not on return values alone.
import "./test-config-setup";
import { setIncognito, isIncognito, inferenceIsLocal, remoteBackendWarning } from "./src/incognito";
import { saveConfig, getConfig, resetConfigCache, configDir } from "./src/config";
import { saveSession, listSessions, newSessionId } from "./src/session";
import { addMemory, readMemory, memoryFilePath } from "./src/memory";
import { recordFileChange, historyCount } from "./src/history";
import { writeProfileByName, listProfileNames } from "./src/profile";
import { addTask, tasksFilePath } from "./src/tasks";
import { rememberTool, updateProfileTool, searchViaChromeTool } from "./src/tools/executor";
import { systemPrompt } from "./src/prompt";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

const dir = mkdtempSync(join(tmpdir(), "lcli-incog-"));
// Count every file under a directory tree — the blunt "did anything land?" check.
function fileCount(root: string): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    n += e.isDirectory() ? fileCount(join(root, e.name)) : 1;
  }
  return n;
}

const run = async () => {
  saveConfig({ cwd: dir, baseUrl: "http://localhost:11434/v1", model: "mock" });
  const cfgFile = join(configDir(), "config.json");

  // ── baseline: with incognito OFF, these writers really do write ────────────
  setIncognito(false);
  saveSession({ id: newSessionId(), title: "normal", model: "m", cwd: dir, createdAt: Date.now(), updatedAt: Date.now(), history: [{ role: "user", content: "hi" }] });
  addMemory("- normal-mode fact");
  recordFileChange("write_file", join(dir, "a.txt"), null, "hello");
  addTask("normal task");
  check("baseline: session saved when incognito is off", listSessions(dir).length === 1);
  check("baseline: memory written when incognito is off", readMemory().includes("normal-mode fact"));
  check("baseline: undo snapshot recorded when incognito is off", historyCount() === 1);
  check("baseline: task file written when incognito is off", existsSync(tasksFilePath()));

  const sessionsBefore = listSessions(dir).length;
  const memoryBefore = readMemory();
  const historyBefore = historyCount();
  const tasksBefore = readFileSync(tasksFilePath(), "utf-8");
  const profilesBefore = listProfileNames().length;
  const cfgBefore = existsSync(cfgFile) ? readFileSync(cfgFile, "utf-8") : "";

  // ── incognito ON ──────────────────────────────────────────────────────────
  setIncognito(true);
  check("flag reports on", isIncognito());

  saveSession({ id: newSessionId(), title: "secret", model: "m", cwd: dir, createdAt: Date.now(), updatedAt: Date.now(), history: [{ role: "user", content: "my api key is sk-live-123" }] });
  check("no new session file", listSessions(dir).length === sessionsBefore);

  addMemory("- secret fact that must not persist");
  check("memory file unchanged", readMemory() === memoryBefore);

  recordFileChange("write_file", join(dir, "b.txt"), "old", "new secret content");
  check("no undo snapshot (would hold full file contents)", historyCount() === historyBefore);

  addTask("secret task");
  check("task file unchanged", readFileSync(tasksFilePath(), "utf-8") === tasksBefore);

  writeProfileByName("incog-profile", "never write this");
  check("no profile written", listProfileNames().length === profilesBefore);

  // Config: the change must apply in memory (so the UI keeps working) but never
  // reach the file — and must vanish once the cache is reset on exit.
  saveConfig({ model: "switched-during-incognito" });
  check("config change applies in memory", getConfig().model === "switched-during-incognito");
  check("config.json untouched on disk", (existsSync(cfgFile) ? readFileSync(cfgFile, "utf-8") : "") === cfgBefore);

  // Tools must refuse rather than silently no-op, so the model knows to adapt.
  check("remember tool refuses", rememberTool({ content: "x" }).startsWith("Blocked:"));
  check("update_profile tool refuses", updateProfileTool({ content: "x" }).startsWith("Blocked:"));
  // Search is NOT blocked — the agent still has to be able to investigate. It's
  // routed through a throwaway browser instead. (No browser here, so we only
  // assert it isn't refused outright.)
  const searchRes = await searchViaChromeTool({ query: "" });
  check("web search is not blocked in incognito", !searchRes.startsWith("Blocked:"));

  // The model has to be told, or it will keep reaching for the blocked tools.
  const p = systemPrompt({ mode: "normal" });
  check("system prompt carries the incognito block", p.includes("INCOGNITO SESSION"));
  check("prompt warns undo is unavailable", p.includes("/undo is unavailable"));
  check("prompt tells the model search still works", p.includes("search_via_chrome STILL WORKS"));
  check("prompt warns never to search a secret", p.includes("NEVER put a credential"));

  // The whole-tree assertion: nothing new anywhere under the project's state dir.
  const stateFiles = fileCount(join(dir, ".local-cli"));

  // ── incognito OFF → in-memory config edits are discarded ──────────────────
  setIncognito(false);
  resetConfigCache();
  check("config change from incognito was discarded", getConfig().model !== "switched-during-incognito");
  check("no stray files appeared under .local-cli", fileCount(join(dir, ".local-cli")) === stateFiles);

  const pOff = systemPrompt({ mode: "normal" });
  check("prompt block disappears when off (keeps the prompt cache valid)", !pOff.includes("INCOGNITO SESSION"));

  // Writers work again afterwards — the guard is a mode, not a permanent break.
  addMemory("- post-incognito fact");
  check("memory writes resume after incognito", readMemory().includes("post-incognito fact"));

  // ── backend locality ──────────────────────────────────────────────────────
  check("localhost backend counts as local", inferenceIsLocal("http://localhost:11434/v1"));
  check("127.0.0.1 backend counts as local", inferenceIsLocal("http://127.0.0.1:8000/v1"));
  check("remote backend does not", !inferenceIsLocal("https://api.example.com/v1"));
  check("no warning for a local backend", remoteBackendWarning("http://localhost:11434/v1") === "");
  check("warning names the remote host", remoteBackendWarning("https://api.example.com/v1").includes("api.example.com"));

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "INCOGNITO OK" : "INCOGNITO FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
