import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";
import ignore, { type Ignore } from "ignore";

export const OUTPUT_BYTES = 16 * 1024;
export const DEFAULT_IGNORES = [".git/", "node_modules/", "vendor/", "dist/", "build/", ".next/", ".nuxt/", ".cache/", "coverage/", "__pycache__/", ".venv/", "venv/", "target/", ".local-cli/", "*.min.js", "*.map"];

// Match with Git's directory/negation semantics. Each operation reloads rules,
// so editing an ignore file takes effect without restarting the agent.
export function workspacePolicy(root: string) {
  root = resolve(root);
  const cache = new Map<string, Ignore>();
  function rules(dir: string): Ignore {
    let rule = cache.get(dir);
    if (!rule) {
      rule = ignore();
      if (dir === root) rule.add(DEFAULT_IGNORES);
      for (const name of [".gitignore", ".localcliignore"]) {
        try { if (statSync(join(dir, name)).size <= 64 * 1024) rule.add(readFileSync(join(dir, name), "utf8")); } catch {}
      }
      cache.set(dir, rule);
    }
    return rule;
  }
  return (path: string, directory = false): boolean => {
    const rel = relative(root, resolve(path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
    const parts = rel.split(sep);
    // An excluded parent cannot be resurrected by a rule inside that parent.
    for (let depth = 1; depth <= parts.length; depth++) {
      const target = join(root, ...parts.slice(0, depth));
      const isDir = depth < parts.length || directory;
      let excluded = false;
      for (let level = 0; level < depth; level++) {
        const base = join(root, ...parts.slice(0, level));
        const match = rules(base).test(relative(base, target).split(sep).join("/") + (isDir ? "/" : ""));
        if (match.ignored) excluded = true;
        if (match.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  };
}

export function scanWorkspace(root: string, start = root, includeIgnored = false) {
  const excluded = workspacePolicy(root);
  const paths: string[] = [];
  let visited = 0, truncated = false;
  function walk(dir: string) {
    if (truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (++visited > 20000) { truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || (!includeIgnored && excluded(path, entry.isDirectory()))) continue;
      paths.push(path);
      if (entry.isDirectory()) walk(path);
      if (truncated) return;
    }
  }
  if (includeIgnored || !excluded(start, true)) walk(start);
  return { paths, truncated };
}

export function boundedText(text: string, bytes = OUTPUT_BYTES): string {
  const buf = Buffer.from(text);
  if (buf.length <= bytes) return text;
  return buf.subarray(0, Math.max(0, bytes - 120)).toString("utf8") + "\n[Output truncated. Narrow the search or request a smaller excerpt.]";
}

export function pageEntries(entries: string[], offset = 0): string {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  let end = start, size = 0;
  const page: string[] = [];
  while (end < entries.length && end - start < 200) {
    const entry = entries[end]!;
    if (size + Buffer.byteLength(entry) > OUTPUT_BYTES - 512) break;
    page.push(entry); size += Buffer.byteLength(entry) + 1; end++;
  }
  return page.join("\n") + (end < entries.length ? `\n[More entries. Continue with offset=${end}.]` : "");
}

export function* textLines(path: string, budget: { remaining: number; limited: boolean; binary: boolean; longLines: boolean }): Generator<{ line: number; text: string }> {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(65536);
  let pending = Buffer.alloc(0), line = 1;
  try {
    while (budget.remaining > 0) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, budget.remaining), null);
      if (!count) { if (pending.length) yield { line, text: pending.toString("utf8") }; return; }
      budget.remaining -= count;
      const chunk = buffer.subarray(0, count);
      if (chunk.includes(0)) { budget.binary = true; return; }
      let start = 0;
      while (start < count) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? count : newline;
        const room = Math.max(0, 16384 - pending.length);
        if (end - start > room) budget.longLines = true;
        pending = Buffer.concat([pending, chunk.subarray(start, Math.min(end, start + room))]);
        if (newline < 0) break;
        yield { line: line++, text: pending.toString("utf8").replace(/\r$/, "") };
        pending = Buffer.alloc(0);
        start = end + 1;
      }
    }
    budget.limited = true;
  } finally { closeSync(fd); }
}

// Fixed-size buffers avoid allocating a million-line file or one enormous line.
// A scan limit also bounds the synchronous work needed for distant offsets.
export function readPage(path: string, offset = 1, limit = 200): string {
  offset = Number.isFinite(offset) ? Math.max(1, Math.floor(offset)) : 1;
  limit = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.floor(limit))) : 200;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(8192);
  const out: string[] = [];
  let line = 1, bytes = 0, scanned = 0, pending: number[] = [];
  const flush = () => {
    const text = `${line}\t${Buffer.from(pending).toString("utf8").replace(/\r$/, "")}`;
    out.push(text); bytes += Buffer.byteLength(text) + 1; pending = [];
  };
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) { if (line >= offset && pending.length) flush(); return out.join("\n"); }
      scanned += n;
      if (scanned > 32 * 1024 * 1024) return out.join("\n") + `\n[Scan limit reached near line ${line}. Narrow the input or use a streaming shell query.]`;
      for (let i = 0; i < n; i++) {
        const b = buf[i]!;
        if (b === 0) return "[Binary file: contents not loaded.]";
        if (line < offset) { if (b === 10) line++; continue; }
        if (b === 10) {
          flush(); line++;
          if (out.length >= limit || bytes >= OUTPUT_BYTES - 512) return out.join("\n") + `\n[Page limit reached. Continue with offset=${line}.]`;
        } else {
          pending.push(b);
          if (bytes + pending.length >= OUTPUT_BYTES - 512) {
            flush();
            return out.join("\n") + `\n[Line ${line} truncated by byte limit; do not edit using this partial line. Use a targeted search or streaming shell query.]`;
          }
        }
      }
    }
  } finally { closeSync(fd); }
}
