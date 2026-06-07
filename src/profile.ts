import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { configDir, getConfig } from "./config";

// The "coding profile" is a personal, cross-project description of HOW the user
// likes code written — their stack, directory/file naming, conventions, and
// practices. Unlike LOCALCLI.md (which is per-project context), the profile
// lives in ~/.local-cli/profile.md and is injected into EVERY system prompt, so
// the agent codes the user's way in every folder. Learned via `/learn`.

function profilePath(): string {
  return join(configDir(), "profile.md");
}

export function readProfile(): string | null {
  const fp = profilePath();
  if (!existsSync(fp)) return null;
  try {
    const c = readFileSync(fp, "utf-8").trim();
    return c || null;
  } catch {
    return null;
  }
}

export function writeProfile(content: string): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(), content.trim() + "\n", "utf-8");
}

export function profileFilePath(): string {
  return profilePath();
}

// ─── Package-manager detection ────────────────────────────────────────────────

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

// Map of lockfile -> the manager that produced it.
const LOCKFILES: Array<[string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

// Detect the package manager actually used in a project by looking for its
// lockfile. Returns null when there's no lockfile (a fresh/empty project) so the
// caller can fall back to the configured default or ask the user.
export function detectPackageManager(cwd: string): PackageManager | null {
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(cwd, file))) return pm;
  }
  return null;
}

// The package manager the agent should use right now: an explicit config choice
// wins; otherwise detect from the project; otherwise null (unknown — the agent
// is told to ask).
export function resolvePackageManager(cwd: string): { pm: PackageManager | null; source: "config" | "detected" | "unknown" } {
  const configured = getConfig().packageManager;
  if (configured && configured !== "auto") return { pm: configured, source: "config" };
  const detected = detectPackageManager(cwd);
  if (detected) return { pm: detected, source: "detected" };
  return { pm: null, source: "unknown" };
}

// The instruction the agent is given to learn the user's coding profile. Used by
// the `/learn` command. The agent explores one or more projects, then writes the
// profile with write_file to the path we pass in.
export function learnProfileInstruction(targetPath: string): string {
  return (
    "Study this project (and how it is built) to learn the USER'S CODING STYLE and conventions, " +
    "so you can reproduce it in future projects. Be thorough: list the directory tree, read the " +
    "package manifest / lockfile, config files, and several representative source files across the codebase.\n\n" +
    "Then use write_file to create a concise markdown profile at:\n" +
    `  ${targetPath}\n\n` +
    "Document, with concrete examples observed in THIS code:\n" +
    "- **Stack**: languages, frameworks, libraries, runtime, and the package manager (bun / npm / pnpm / yarn — infer from the lockfile).\n" +
    "- **Directory conventions**: how folders are named and organized (e.g. `src/api`, `components/`, kebab vs camel).\n" +
    "- **File naming**: casing and patterns (e.g. `PascalCase.tsx` for components, `kebab-case.ts` for utils).\n" +
    "- **Code conventions**: imports style, quotes, semicolons, indentation, type usage, error handling, comments.\n" +
    "- **Architecture patterns**: how features are structured, where logic lives, common abstractions.\n" +
    "- **Practices**: testing approach, scripts, how the app is run/built/served.\n\n" +
    "Write it as clear, prescriptive rules a developer could follow to match this style. Keep it under ~70 lines. " +
    "Do NOT include secrets, absolute machine paths, or project-specific business data — only reusable style and conventions."
  );
}
