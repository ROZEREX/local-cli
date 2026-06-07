import "./test-config-setup";
import { saveConfig, resetConfigCache } from "./src/config";
import { readProfile, writeProfile, detectPackageManager, resolvePackageManager } from "./src/profile";
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

for (const d of [bunDir, pnpmDir, yarnDir, npmDir, emptyDir]) rmSync(d, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PROFILE OK" : "PROFILE FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
