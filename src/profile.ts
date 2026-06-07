import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { configDir, getConfig, saveConfig } from "./config";

// A "coding profile" is a personal, cross-project description of HOW the user
// likes code written — stack, directory/file naming, conventions, practices.
// Unlike LOCALCLI.md (per-project context), profiles live in
// ~/.local-cli/profiles/<name>.md and the ACTIVE one is injected into EVERY
// system prompt, so the agent codes the user's way in every folder.
//
// There can be many named profiles (e.g. "web", "desktop", "mobile") so the
// same CLI serves different kinds of work. The agent can also update the active
// profile itself via the update_profile tool, so what it learns persists.

function profilesDir(): string {
  return join(configDir(), "profiles");
}

// Turn a human name into a safe filename slug ("My Web App" -> "my-web-app").
export function slugifyProfile(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function profileFile(name: string): string {
  return join(profilesDir(), `${slugifyProfile(name)}.md`);
}

// One-time migration: the old single ~/.local-cli/profile.md becomes the
// "default" named profile, and is made active if nothing else is.
let migrated = false;
function ensureMigrated(): void {
  if (migrated) return;
  migrated = true;
  const legacy = join(configDir(), "profile.md");
  if (existsSync(legacy)) {
    if (!existsSync(profilesDir())) mkdirSync(profilesDir(), { recursive: true });
    const dest = profileFile("default");
    if (!existsSync(dest)) {
      try {
        renameSync(legacy, dest);
        if (!getConfig().activeProfile) saveConfig({ activeProfile: "default" });
      } catch {
        /* leave legacy in place if move fails */
      }
    }
  }
}

export function profileFilePath(name?: string): string {
  return profileFile(name || activeOrDefaultName());
}

// All profile names that exist on disk.
export function listProfileNames(): string[] {
  ensureMigrated();
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".md"))
    .map(f => f.slice(0, -3))
    .sort();
}

export function profileExists(name: string): boolean {
  return existsSync(profileFile(name));
}

export function readProfileByName(name: string): string | null {
  ensureMigrated();
  const fp = profileFile(name);
  if (!existsSync(fp)) return null;
  try {
    const c = readFileSync(fp, "utf-8").trim();
    return c || null;
  } catch {
    return null;
  }
}

// Write (replace) or append to a named profile. Creates the profiles dir and the
// file if needed. If this is the first profile, it becomes active.
export function writeProfileByName(name: string, content: string, mode: "replace" | "append" = "replace"): void {
  ensureMigrated();
  const dir = profilesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = profileFile(name);
  const hadAny = listProfileNames().length > 0;
  if (mode === "append" && existsSync(fp)) {
    const prev = readFileSync(fp, "utf-8").replace(/\s+$/, "");
    writeFileSync(fp, prev + "\n\n" + content.trim() + "\n", "utf-8");
  } else {
    writeFileSync(fp, content.trim() + "\n", "utf-8");
  }
  if (!hadAny && !getConfig().activeProfile) saveConfig({ activeProfile: slugifyProfile(name) });
}

export function deleteProfileByName(name: string): boolean {
  ensureMigrated();
  const fp = profileFile(name);
  if (!existsSync(fp)) return false;
  try { unlinkSync(fp); } catch { return false; }
  if (getConfig().activeProfile === slugifyProfile(name)) saveConfig({ activeProfile: "" });
  return true;
}

export function setActiveProfile(name: string): void {
  saveConfig({ activeProfile: slugifyProfile(name) });
}

// The active profile name: the configured one if set, else the only profile if
// there's exactly one, else "default".
function activeOrDefaultName(): string {
  const cfg = getConfig().activeProfile;
  if (cfg) return cfg;
  const names = listProfileNames();
  if (names.length === 1) return names[0]!;
  return "default";
}

export function getActiveProfileName(): string | null {
  ensureMigrated();
  const cfg = getConfig().activeProfile;
  if (cfg && profileExists(cfg)) return slugifyProfile(cfg);
  const names = listProfileNames();
  if (names.length === 1) return names[0]!;     // auto-use the only one
  return null;                                  // ambiguous / none → inject nothing
}

// Content of the active profile, for the system prompt. Null when none is active.
export function readActiveProfile(): string | null {
  const name = getActiveProfileName();
  return name ? readProfileByName(name) : null;
}

// ─── Backward-compatible thin wrappers (used by older callers/tests) ──────────
export function readProfile(): string | null {
  return readActiveProfile();
}
export function writeProfile(content: string): void {
  writeProfileByName("default", content);
  if (!getConfig().activeProfile) setActiveProfile("default");
}

// ─── Package-manager detection ────────────────────────────────────────────────

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const LOCKFILES: Array<[string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(cwd: string): PackageManager | null {
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(cwd, file))) return pm;
  }
  return null;
}

export function resolvePackageManager(cwd: string): { pm: PackageManager | null; source: "config" | "detected" | "unknown" } {
  const configured = getConfig().packageManager;
  if (configured && configured !== "auto") return { pm: configured, source: "config" };
  const detected = detectPackageManager(cwd);
  if (detected) return { pm: detected, source: "detected" };
  return { pm: null, source: "unknown" };
}

// Instruction for the `/learn` command. The agent explores the project, then
// writes the named profile with write_file to the path we pass in.
export function learnProfileInstruction(targetPath: string, profileName: string): string {
  return (
    `Study this project to learn the USER'S CODING STYLE and conventions, and save them as the "${profileName}" coding profile ` +
    "so you can reproduce this style in FUTURE projects (even in empty folders).\n\n" +
    "Be thorough and DO NOT assume the layout. First list the FULL directory tree from the project ROOT — not just src/. " +
    "Read the package manifest / lockfile, config files, and several representative source files from EVERY significant top-level " +
    "area (e.g. api/, server/, src/, components/, lib/, tests/), so you don't miss folders that live outside src/.\n\n" +
    "Then use write_file to create a concise markdown profile at:\n" +
    `  ${targetPath}\n\n` +
    "Document, with concrete examples observed in THIS code:\n" +
    "- **Stack**: languages, frameworks, libraries, runtime, and package manager (infer from the lockfile).\n" +
    "- **Directory conventions**: how folders are named/organized, including where things like API/server code live.\n" +
    "- **File naming**: casing and patterns (e.g. PascalCase components, kebab-case utils).\n" +
    "- **Code conventions**: imports, quotes, semicolons, indentation, types, error handling, comments.\n" +
    "- **Architecture patterns**: how features are structured and where logic lives.\n" +
    "- **Practices**: testing, scripts, how the app is run/built/served.\n\n" +
    "Write prescriptive rules a developer could follow to match this style. Keep it under ~70 lines. " +
    "Do NOT include secrets, absolute machine paths, or business data — only reusable style and conventions."
  );
}
