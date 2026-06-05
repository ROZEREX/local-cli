import { readdirSync, statSync, readFileSync } from "fs";
import { join, relative } from "path";

export interface DirEntry { name: string; isDir: boolean; }

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor", "__pycache__", ".venv", "venv", "target"]);
const MAX_FILE_BYTES = 100 * 1024;       // skip files larger than this
const MAX_TOTAL_BYTES = 200 * 1024;      // cap total injected content
const MAX_FILES = 100;                    // cap number of files

// List a directory: dirs first (alpha), then files (alpha). Hidden + ignored
// dirs are skipped. A ".." entry is added unless `isRoot`.
export function listDirEntries(dir: string, isRoot = false): DirEntry[] {
  let items: any[];
  try { items = readdirSync(dir, { withFileTypes: true }) as any[]; } catch { return []; }
  const dirs: DirEntry[] = [];
  const files: DirEntry[] = [];
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    if (it.isDirectory()) { if (!IGNORE_DIRS.has(it.name)) dirs.push({ name: it.name, isDir: true }); }
    else if (it.isFile()) files.push({ name: it.name, isDir: false });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...(isRoot ? [] : [{ name: "..", isDir: true }]), ...dirs, ...files];
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Recursively collect file paths under a directory, respecting ignores/limits.
function walk(dir: string, out: string[]) {
  if (out.length >= MAX_FILES) return;
  let items: any[];
  try { items = readdirSync(dir, { withFileTypes: true }) as any[]; } catch { return; }
  for (const it of items) {
    if (out.length >= MAX_FILES) return;
    if (it.name.startsWith(".")) continue;
    const full = join(dir, it.name);
    if (it.isDirectory()) { if (!IGNORE_DIRS.has(it.name)) walk(full, out); }
    else if (it.isFile()) out.push(full);
  }
}

// Expand a selection (files and/or dirs) into a concrete list of file paths.
export function expandSelection(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    try {
      if (statSync(p).isDirectory()) walk(p, files);
      else files.push(p);
    } catch { /* skip */ }
  }
  return [...new Set(files)].slice(0, MAX_FILES);
}

export interface AttachResult { block: string; included: string[]; skipped: number; truncated: boolean; }

// Read the given files into a single context block, respecting size caps.
export function readFilesAsContext(paths: string[], cwd: string): AttachResult {
  const parts: string[] = [];
  const included: string[] = [];
  let total = 0, skipped = 0, truncated = false;
  for (const p of paths) {
    if (total >= MAX_TOTAL_BYTES) { truncated = true; break; }
    let buf: Buffer;
    try { buf = readFileSync(p); } catch { skipped++; continue; }
    if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) { skipped++; continue; }
    const rel = relative(cwd, p) || p;
    const content = buf.toString("utf-8");
    parts.push(`--- ${rel} ---\n${content}`);
    included.push(rel);
    total += buf.length;
  }
  return { block: parts.join("\n\n"), included, skipped, truncated };
}
