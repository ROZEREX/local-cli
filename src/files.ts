import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join, relative, resolve, dirname, isAbsolute } from "path";
import { scanWorkspace, workspacePolicy, boundedText } from "./workspace";

import { getConfig } from "./config";

export interface DirEntry { name: string; isDir: boolean; }

const MAX_FILE_BYTES = 100 * 1024;       // skip files larger than this
const MAX_TOTAL_BYTES = 16 * 1024;      // cap total injected content
const MAX_FILES = 100;                    // cap number of files

export function isRootDir(dir: string): boolean {
  try {
    const parent = dirname(dir);
    return parent === dir || /^[a-zA-Z]:\\?$/i.test(dir) || dir === "/" || dir === "\\";
  } catch {
    return false;
  }
}

export function listDrives(): string[] {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const drives: string[] = [];
  for (const l of letters) {
    const d = `${l}:\\`;
    try {
      if (existsSync(d)) drives.push(d);
    } catch {}
  }
  return drives;
}

export function normalizeBrowsePath(p?: string | null, fallback?: string): string {
  let s = (p ?? "").trim();
  if (!s) return fallback ?? process.cwd();
  if (/^[a-zA-Z]:$/.test(s)) s += "\\";
  try {
    let resolved = resolve(s);
    if (/^[a-zA-Z]:$/.test(resolved)) resolved += "\\";
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {}
  return fallback ?? process.cwd();
}

// List a directory: dirs first (alpha), then files (alpha). Hidden + ignored
// dirs are skipped. A ".." entry is added unless `isRoot` or already at filesystem root.
export function listDirEntries(dir: string, isRoot = false): DirEntry[] {
  const cwd = getConfig().cwd;
  const rel = relative(cwd, dir);
  const excluded = workspacePolicy(rel.startsWith("..") || isAbsolute(rel) ? dir : cwd);
  let items: any[];
  try { items = readdirSync(dir, { withFileTypes: true }) as any[]; } catch { return []; }
  const dirs: DirEntry[] = [];
  const files: DirEntry[] = [];
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    if (excluded(join(dir, it.name), it.isDirectory())) continue;
    if (it.isDirectory()) dirs.push({ name: it.name, isDir: true });
    else if (it.isFile()) files.push({ name: it.name, isDir: false });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const showDotDot = !isRoot && !isRootDir(dir);
  return [...(showDotDot ? [{ name: "..", isDir: true }] : []), ...dirs, ...files];
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Expand a selection (files and/or dirs) into a concrete list of file paths.
export function expandSelection(paths: string[], cwd?: string): string[] {
  const files: string[] = [];
  for (const p of paths) {
    try {
      if (statSync(p).isDirectory()) files.push(...scanWorkspace(cwd ?? p, p).paths.filter(f => statSync(f).isFile()));
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
  let total = 0, skipped = 0, truncated = paths.length > MAX_FILES;
  const append = (block: string) => {
    const size = Buffer.byteLength(block) + 2;
    if (total + size > MAX_TOTAL_BYTES - 256) { truncated = true; return false; }
    parts.push(block); total += size; return true;
  };
  for (const p of paths.slice(0, MAX_FILES)) {
    if (total >= MAX_TOTAL_BYTES) { truncated = true; break; }
    let buf: Buffer;
    try {
      if (statSync(p).size > MAX_FILE_BYTES) {
        skipped++;
        if (!append(`--- ${relative(cwd, p)} ---\n[Large file: contents not attached. Request read_file with offset/limit.]`)) break;
        continue;
      }
      buf = readFileSync(p);
    } catch { skipped++; continue; }
    if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) { skipped++; continue; }
    const rel = relative(cwd, p) || p;
    const content = buf.toString("utf-8");
    if (!append(`--- ${rel} ---\n${content}`)) {
      append(`--- ${rel} ---\n[File exceeds remaining attachment budget. Request read_file with offset/limit.]`);
      break;
    }
    included.push(rel);
  }
  return { block: boundedText(parts.join("\n\n") + (truncated ? "\n[Attachment budget reached. Read individual files in pages.]" : "")), included, skipped, truncated };
}

export function expandFileMentions(input: string, cwd: string): string {
  const paths = [...new Set([...input.matchAll(/@(\S+)/g)].map(m => resolve(cwd, m[1]!)))];
  return input + (paths.length ? "\n\n" + readFilesAsContext(paths.slice(0, MAX_FILES), cwd).block : "");
}
