import "./test-config-setup";
import { saveConfig, resetConfigCache, getConfig } from "./src/config";
import {
  readProfile, writeProfile, detectPackageManager, resolvePackageManager,
  writeProfileByName, readProfileByName, listProfileNames, setActiveProfile,
  getActiveProfileName, deleteProfileByName,
} from "./src/profile";
import { executeTool } from "./src/tools/executor";
import { systemPrompt } from "./src/prompt";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

// ─── package manager detection ────────────────────────────────────────────────
function freshProject(lockfile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lcli-pm-"));
  writeFileSync(join(dir, "package.json"), "{}");
  if (lockfile) writeFileSync(join(dir, lockfile), "");
  return dir;
}

const bunDir = freshProject("bun.lock");
check("detects bun from bun.lock", detectPackageManager(bunDir) === "bun");

const pnpmDir = freshProject("pnpm-lock.yaml");
check("detects pnpm from pnpm-lock.yaml", detectPackageManager(pnpmDir) === "pnpm");

const yarnDir = freshProject("yarn.lock");
check("detects yarn from yarn.lock", detectPackageManager(yarnDir) === "yarn");

const npmDir = freshProject("package-lock.json");
check("detects npm from package-lock.json", detectPackageManager(npmDir) === "npm");

const emptyDir = freshProject();
check("returns null when no lockfile", detectPackageManager(emptyDir) === null);

// resolvePackageManager: explicit config wins over detection
saveConfig({ cwd: bunDir, packageManager: "npm" });
let r = resolvePackageManager(bunDir);
check("config choice overrides detection", r.pm === "npm" && r.source === "config", JSON.stringify(r));

// auto falls back to detection
saveConfig({ packageManager: "auto" });
r = resolvePackageManager(bunDir);
check("auto detects from lockfile", r.pm === "bun" && r.source === "detected", JSON.stringify(r));

// auto with no lockfile = unknown
r = resolvePackageManager(emptyDir);
check("auto with no lockfile is unknown", r.pm === null && r.source === "unknown", JSON.stringify(r));

// ─── profile read/write ───────────────────────────────────────────────────────
check("no profile initially", readProfile() === null);

writeProfile("# My Style\n- Use bun\n- kebab-case files");
const p = readProfile();
check("profile round-trips", !!p && p.includes("kebab-case files"), String(p));

// ─── system prompt injection ──────────────────────────────────────────────────
saveConfig({ cwd: bunDir, packageManager: "auto" });
resetConfigCache();
saveConfig({ cwd: bunDir });
let sp = systemPrompt();
check("prompt includes the coding profile", sp.includes("kebab-case files"), "");
check("prompt mentions detected package manager", sp.includes("bun") && sp.toLowerCase().includes("package manager"), "");

// unknown package manager → prompt tells the agent to ask
saveConfig({ cwd: emptyDir, packageManager: "auto" });
sp = systemPrompt();
check("prompt asks which PM when unknown", sp.includes("ASK the user whether to use bun, npm, pnpm, or yarn"), "");

// ─── multiple named profiles ──────────────────────────────────────────────────
writeProfileByName("web", "# Web\n- React + Vite\n- kebab-case files");
writeProfileByName("desktop", "# Desktop\n- Electron\n- PascalCase files");
const names = listProfileNames();
check("lists multiple profiles", names.includes("web") && names.includes("desktop"), names.join(","));

setActiveProfile("desktop");
check("active profile is selectable", getActiveProfileName() === "desktop");
check("active profile content is read", (readProfile() ?? "").includes("Electron"));

// switching active changes what the prompt injects
saveConfig({ cwd: emptyDir });
let sp2 = systemPrompt();
check("prompt injects the ACTIVE profile (desktop)", sp2.includes("Electron") && !sp2.includes("Vite"), "");
setActiveProfile("web");
sp2 = systemPrompt();
check("switching active profile switches the prompt (web)", sp2.includes("Vite") && !sp2.includes("Electron"), "");

// ─── update_profile / read_profile tools (agent-driven, no command) ───────────
setActiveProfile("web");
let tr = await executeTool("update_profile", { content: "- API lives in /api outside src/" });
check("update_profile confirms save", tr.includes("profile") && tr.toLowerCase().includes("web"), tr);
check("update_profile appended to the active profile", (readProfileByName("web") ?? "").includes("API lives in /api"), readProfileByName("web") ?? "");
check("update_profile kept existing content", (readProfileByName("web") ?? "").includes("Vite"));

tr = await executeTool("read_profile", {});
check("read_profile returns the active profile", tr.includes("Vite") && tr.includes("API lives in /api"), tr);

tr = await executeTool("update_profile", { content: "x" });
tr = await executeTool("update_profile", {});
check("update_profile without content errors", tr.toLowerCase().includes("content was not provided"), tr);

// write to a specific named profile via the tool
tr = await executeTool("update_profile", { content: "- Use Tailwind", name: "web", mode: "append" });
check("update_profile targets a named profile", (readProfileByName("web") ?? "").includes("Tailwind"), "");

// delete
check("deletes a profile", deleteProfileByName("desktop") === true && !listProfileNames().includes("desktop"));

for (const d of [bunDir, pnpmDir, yarnDir, npmDir, emptyDir]) rmSync(d, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PROFILE OK" : "PROFILE FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
