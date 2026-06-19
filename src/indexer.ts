import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { glob } from "glob";
import { getConfig } from "./config";

// Workspace indexing: scan the project once, extract symbols (functions,
// classes, endpoints, components) and text chunks, and persist the result to
// <project>/.local-cli/index.json. Search (src/search.ts) runs over this index
// — with embeddings when an Ollama embedding model is installed — so "where are
// JWT tokens generated?" finds code without exact keywords.

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "component" | "endpoint" | "type" | "const";
  file: string;     // relative path
  line: number;     // 1-based
  signature: string;
}

export interface CodeChunk {
  file: string;
  startLine: number; // 1-based
  text: string;
}

export interface WorkspaceIndex {
  builtAt: number;
  cwd: string;
  fileCount: number;
  symbols: CodeSymbol[];
  chunks: CodeChunk[];
  // Chunk embeddings (parallel to `chunks`), present when an embedding model
  // was available at build time.
  embedModel?: string;
  embeddings?: number[][];
}

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,php,py,rb,go,rs,java,cs,vue,svelte}";
const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/build/**", "**/vendor/**", "**/.local-cli/**", "**/*.min.js", "**/coverage/**"];
const MAX_FILE_BYTES = 400 * 1024;
const CHUNK_LINES = 40;
const CHUNK_STRIDE = 32;
const MAX_CHUNKS = 4000;

export function indexFilePath(): string {
  return join(getConfig().cwd, ".local-cli", "index.json");
}

// ── symbol extraction (regex-based, per language family) ─────────────────────
function extractSymbols(file: string, content: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = content.split("\n");
  const push = (name: string, kind: CodeSymbol["kind"], line: number, signature: string) => {
    if (name && name.length > 1) out.push({ name, kind, file, line: line + 1, signature: signature.trim().slice(0, 120) });
  };

  const isJsLike = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(file);
  const isPy = file.endsWith(".py");
  const isPhp = file.endsWith(".php");

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isJsLike) {
      let m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { push(m[1]!, /^[A-Z]/.test(m[1]!) ? "component" : "function", i, l); continue; }
      m = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { push(m[1]!, "class", i, l); continue; }
      m = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(l);
      if (m) { push(m[1]!, /^[A-Z]/.test(m[1]!) ? "component" : "function", i, l); continue; }
      m = /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { push(m[1]!, "type", i, l); continue; }
      // Express/Koa/Fastify/Bun routes: app.get('/path', …)
      m = /\b(?:app|router|server|api)\.(get|post|put|patch|delete|all|use)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(l);
      if (m) { push(`${m[1]!.toUpperCase()} ${m[2]}`, "endpoint", i, l); continue; }
      // Nest decorators: @Get('path')
      m = /@\s*(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/.exec(l);
      if (m) { push(`${m[1]!.toUpperCase()} /${m[2] || ""}`, "endpoint", i, l); continue; }
    } else if (isPy) {
      let m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(l);
      if (m) { push(m[1]!, "function", i, l); continue; }
      m = /^\s*class\s+([A-Za-z_]\w*)/.exec(l);
      if (m) { push(m[1]!, "class", i, l); continue; }
      m = /@\s*(?:app|router|api)\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/.exec(l);
      if (m) { push(`${m[1]!.toUpperCase()} ${m[2]}`, "endpoint", i, l); continue; }
    } else if (isPhp) {
      let m = /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/.exec(l);
      if (m) { push(m[1]!, "function", i, l); continue; }
      m = /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/.exec(l);
      if (m) { push(m[1]!, "class", i, l); continue; }
      m = /Route::(get|post|put|patch|delete|any)\s*\(\s*["']([^"']+)["']/.exec(l);
      if (m) { push(`${m[1]!.toUpperCase()} ${m[2]}`, "endpoint", i, l); continue; }
    } else {
      // Generic: Go/Rust/Java/C#/Ruby function-ish declarations.
      const m = /^\s*(?:pub\s+)?(?:func|fn|def)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(l) ||
                /^\s*(?:public|private|protected|internal|static|\s)+[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(/.exec(l);
      if (m) { push(m[1]!, "function", i, l); continue; }
      const c = /^\s*(?:pub\s+)?(?:class|struct|trait|impl|module)\s+([A-Za-z_]\w*)/.exec(l);
      if (c) { push(c[1]!, "class", i, l); continue; }
    }
  }
  return out;
}

function chunkFile(file: string, content: string): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length <= CHUNK_LINES) {
    const text = content.trim();
    return text ? [{ file, startLine: 1, text }] : [];
  }
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_STRIDE) {
    const slice = lines.slice(start, start + CHUNK_LINES).join("\n").trim();
    if (slice) chunks.push({ file, startLine: start + 1, text: slice });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

// Build (or rebuild) the workspace index. Pure scan — embeddings are attached
// by search.ts when a model is available.
export async function buildIndex(): Promise<WorkspaceIndex> {
  const cwd = getConfig().cwd;
  const files = await glob(SOURCE_GLOB, { cwd, nodir: true, absolute: true, ignore: IGNORE });
  const symbols: CodeSymbol[] = [];
  const chunks: CodeChunk[] = [];

  for (const abs of files) {
    let content: string;
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      content = readFileSync(abs, "utf-8");
    } catch { continue; }
    const rel = relative(cwd, abs).replace(/\\/g, "/");
    symbols.push(...extractSymbols(rel, content));
    if (chunks.length < MAX_CHUNKS) chunks.push(...chunkFile(rel, content));
  }
  if (chunks.length > MAX_CHUNKS) chunks.length = MAX_CHUNKS;

  const index: WorkspaceIndex = { builtAt: Date.now(), cwd, fileCount: files.length, symbols, chunks };
  saveIndex(index);
  return index;
}

export function saveIndex(index: WorkspaceIndex): void {
  const fp = indexFilePath();
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Round embedding floats to shrink the JSON considerably.
  const json = JSON.stringify(index, (k, v) =>
    typeof v === "number" && k !== "builtAt" && k !== "fileCount" && k !== "startLine" && k !== "line"
      ? Math.round(v * 1e4) / 1e4
      : v
  );
  writeFileSync(fp, json, "utf-8");
}

export function loadIndex(): WorkspaceIndex | null {
  const fp = indexFilePath();
  if (!existsSync(fp)) return null;
  try {
    const idx = JSON.parse(readFileSync(fp, "utf-8")) as WorkspaceIndex;
    if (idx.cwd !== getConfig().cwd) return null; // stale (copied from elsewhere)
    return idx;
  } catch { return null; }
}

export function describeIndex(idx: WorkspaceIndex): string {
  const byKind = new Map<string, number>();
  for (const s of idx.symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const kinds = [...byKind.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
  const age = Math.round((Date.now() - idx.builtAt) / 60000);
  return `Workspace index: ${idx.fileCount} files, ${idx.symbols.length} symbols (${kinds || "none"}), ${idx.chunks.length} chunks` +
    (idx.embeddings ? `, embeddings via ${idx.embedModel}` : ", no embeddings (keyword search)") +
    ` — built ${age < 1 ? "just now" : `${age} min ago`}. Rebuild with /index.`;
}
