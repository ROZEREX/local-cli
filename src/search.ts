import { getConfig } from "./config";
import { listOllamaModelsDetailed, modelCapabilities, isOllama } from "./ollama";
import { buildIndex, loadIndex, saveIndex, type WorkspaceIndex, type CodeChunk } from "./indexer";

// Semantic code search over the workspace index. Uses a local Ollama embedding
// model when one is installed (nomic-embed-text, mxbai-embed-large, bge-m3,
// all-minilm, snowflake-arctic-embed…) and falls back to smart keyword scoring
// otherwise — so search_code always works, it's just sharper with embeddings.

const EMBED_NAME_RE = /embed|bge|minilm|e5|arctic|gte/i;

let _embedModel: string | null | undefined; // undefined = not probed yet

export async function findEmbeddingModel(): Promise<string | null> {
  if (_embedModel !== undefined) return _embedModel;
  const cfg = getConfig();
  try {
    if (!(await isOllama(cfg.baseUrl))) { _embedModel = null; return null; }
    const models = await listOllamaModelsDetailed(cfg.baseUrl);
    // Prefer models whose reported capabilities include "embedding"; fall back
    // to well-known embedding-model names.
    for (const m of models) {
      const caps = await modelCapabilities(cfg.baseUrl, m.name).catch(() => [] as string[]);
      if (caps.includes("embedding")) { _embedModel = m.name; return m.name; }
    }
    const byName = models.find(m => EMBED_NAME_RE.test(m.name));
    _embedModel = byName?.name ?? null;
  } catch {
    _embedModel = null;
  }
  return _embedModel;
}

export function resetEmbedModelCache(): void { _embedModel = undefined; }

async function embed(texts: string[], model: string): Promise<number[][]> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const out: number[][] = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(`${host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) throw new Error(`Embedding request failed (${res.status}): ${await res.text().catch(() => "")}`);
    const data: any = await res.json();
    const vecs: number[][] = data.embeddings ?? [];
    if (vecs.length !== batch.length) throw new Error("Embedding API returned a mismatched number of vectors.");
    out.push(...vecs);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Make sure an index exists; optionally attach embeddings to it.
export async function ensureIndex(opts: { rebuild?: boolean; withEmbeddings?: boolean } = {}): Promise<WorkspaceIndex> {
  let idx = opts.rebuild ? null : loadIndex();
  if (!idx) idx = await buildIndex();
  if (opts.withEmbeddings !== false && !idx.embeddings && idx.chunks.length > 0) {
    const model = await findEmbeddingModel();
    if (model) {
      try {
        idx.embeddings = await embed(idx.chunks.map(chunkEmbedText), model);
        idx.embedModel = model;
        saveIndex(idx);
      } catch { /* keyword fallback still works */ }
    }
  }
  return idx;
}

// What we embed for a chunk: path + content (the path carries real signal —
// "auth/jwt.ts" should match "where are JWT tokens generated").
function chunkEmbedText(c: CodeChunk): string {
  return `${c.file}\n${c.text}`.slice(0, 2000);
}

// Split camelCase / snake-case / kebab-case identifiers into words.
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1);
}

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "where", "what", "how", "in", "of", "to", "for", "and", "or", "do", "does", "find", "code", "file", "files", "que", "donde", "como", "los", "las", "del", "el", "la", "en", "de", "se"]);

function keywordScore(queryWords: string[], c: CodeChunk): number {
  const hay = (c.file + "\n" + c.text).toLowerCase();
  const hayWords = new Set(words(hay));
  let score = 0;
  for (const w of queryWords) {
    if (hayWords.has(w)) score += 2;
    else if (hay.includes(w)) score += 1;
  }
  return score / Math.max(1, queryWords.length);
}

export interface SearchHit {
  file: string;
  line: number;
  score: number;
  snippet: string;
  via: "embeddings" | "keywords" | "symbol";
}

export async function searchCode(query: string, k = 8): Promise<{ hits: SearchHit[]; via: string }> {
  const idx = await ensureIndex();
  const hits: SearchHit[] = [];
  const qWords = words(query).filter(w => !STOPWORDS.has(w));

  // 1. Symbol-name matches always rank (instant, precise).
  for (const s of idx.symbols) {
    const sw = words(s.name);
    const overlap = qWords.filter(w => sw.includes(w) || s.name.toLowerCase().includes(w)).length;
    if (overlap > 0 && overlap >= Math.min(2, qWords.length)) {
      hits.push({ file: s.file, line: s.line, score: 0.5 + overlap / Math.max(1, qWords.length), snippet: `[${s.kind}] ${s.signature}`, via: "symbol" });
    }
  }

  // 2. Semantic chunk search (embeddings if available, else keywords).
  let via: "embeddings" | "keywords" = "keywords";
  if (idx.embeddings && idx.embedModel && idx.embeddings.length === idx.chunks.length) {
    try {
      const [qv] = await embed([query], idx.embedModel);
      if (qv) {
        via = "embeddings";
        idx.chunks.forEach((c, i) => {
          const score = cosine(qv, idx.embeddings![i]!);
          if (score > 0.3) hits.push({ file: c.file, line: c.startLine, score, snippet: firstLines(c.text, 3), via: "embeddings" });
        });
      }
    } catch { /* fall through to keywords */ }
  }
  if (via === "keywords") {
    for (const c of idx.chunks) {
      const score = keywordScore(qWords, c);
      if (score > 0.3) hits.push({ file: c.file, line: c.startLine, score, snippet: firstLines(c.text, 3), via: "keywords" });
    }
  }

  // Dedupe by file (keep the best 2 hits per file so one big file doesn't
  // swallow the result list), then take top-k.
  hits.sort((a, b) => b.score - a.score);
  const perFile = new Map<string, number>();
  const top: SearchHit[] = [];
  for (const h of hits) {
    const n = perFile.get(h.file) ?? 0;
    if (n >= 2) continue;
    perFile.set(h.file, n + 1);
    top.push(h);
    if (top.length >= k) break;
  }
  return { hits: top, via };
}

function firstLines(s: string, n: number): string {
  return s.split("\n").slice(0, n).join("\n").slice(0, 240);
}

export function formatSearchResults(query: string, r: { hits: SearchHit[]; via: string }): string {
  if (r.hits.length === 0) {
    return `No results for "${query}". The index may be stale — rebuild with /index — or try different wording. grep_files works for exact strings.`;
  }
  const lines = r.hits.map(h =>
    `${h.file}:${h.line}  (${h.via}${h.via === "symbol" ? "" : `, ${(h.score * 100).toFixed(0)}%`})\n${h.snippet.split("\n").map(l => "    " + l).join("\n")}`
  );
  return `Results for "${query}" (via ${r.via}):\n\n${lines.join("\n\n")}\n\nUse read_file on a result to see the full context.`;
}
