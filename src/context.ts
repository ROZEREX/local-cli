import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Files we treat as project memory, in priority order. The first one found in
// the working directory is loaded into the system prompt so the agent starts
// every session already knowing the project's purpose, layout, and conventions.
const CONTEXT_FILES = ["LOCALCLI.md", ".localcli/context.md", "AGENTS.md", "CLAUDE.md"];

export interface ProjectContext {
  file: string;
  content: string;
}

export function findProjectContext(cwd: string): ProjectContext | null {
  for (const rel of CONTEXT_FILES) {
    const fp = join(cwd, rel);
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, "utf-8").trim();
        if (content) return { file: rel, content };
      } catch {
        /* unreadable — try the next candidate */
      }
    }
  }
  return null;
}

// The canonical file we write to with /init.
export const PRIMARY_CONTEXT_FILE = CONTEXT_FILES[0];
