// Talks to Ollama's native API (separate from the OpenAI-compatible /v1 path)
// to list installed models and detect whether a model supports native tool
// calling. Gracefully no-ops for non-Ollama endpoints.

function ollamaHost(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

// List models actually installed in the local Ollama (GET /api/tags).
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const host = ollamaHost(baseUrl);
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data: any = await res.json();
  return (data.models ?? []).map((m: any) => m.name).filter(Boolean).sort();
}

// Human-readable byte size, e.g. 4831838208 -> "4.5 GB".
export function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Compact context length, e.g. 131072 -> "128k", 32768 -> "32k".
export function formatCtx(n: number | undefined): string {
  if (!n || n <= 0) return "";
  if (n >= 1024) {
    const k = n / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}k ctx`;
  }
  return `${n} ctx`;
}

export interface OllamaModelInfo {
  name: string;
  size?: number;            // on-disk bytes
  parameterSize?: string;   // e.g. "7.6B"
  quantization?: string;    // e.g. "Q4_K_M"
  family?: string;          // e.g. "qwen2"
  contextLength?: number;   // native max context (from /api/show)
  capabilities?: string[];  // e.g. ["completion","tools","thinking"]
}

// Lightweight per-model summary from a single GET /api/tags call (no context
// length — that needs /api/show per model). Good for list/picker hints.
export async function listOllamaModelsDetailed(baseUrl: string): Promise<OllamaModelInfo[]> {
  const host = ollamaHost(baseUrl);
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data: any = await res.json();
  return (data.models ?? [])
    .map((m: any): OllamaModelInfo => ({
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      family: m.details?.family,
    }))
    .filter((m: OllamaModelInfo) => m.name)
    .sort((a: OllamaModelInfo, b: OllamaModelInfo) => a.name.localeCompare(b.name));
}

// Full detail for ONE model via POST /api/show — adds native context length and
// capabilities. One extra round-trip, so call it on demand (e.g. /modelinfo),
// not for every model in a list.
export async function modelInfo(baseUrl: string, model: string): Promise<OllamaModelInfo | null> {
  const host = ollamaHost(baseUrl);
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const mi = data.model_info ?? {};
    const arch = mi["general.architecture"];
    const contextLength = arch ? mi[`${arch}.context_length`] : undefined;
    return {
      name: model,
      parameterSize: data.details?.parameter_size,
      quantization: data.details?.quantization_level,
      family: data.details?.family,
      contextLength: typeof contextLength === "number" ? contextLength : undefined,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    };
  } catch {
    return null;
  }
}

// Build a one-line hint like "7.6B · Q4_K_M · 4.5 GB" from a summary.
export function modelHint(m: OllamaModelInfo): string {
  return [m.parameterSize, m.quantization, formatBytes(m.size), formatCtx(m.contextLength)]
    .filter(Boolean)
    .join(" · ");
}

// Detect native tool support for a model. Returns true/false, or null when it
// can't be determined (e.g. the endpoint isn't Ollama).
export async function detectToolSupport(baseUrl: string, model: string): Promise<boolean | null> {
  const host = ollamaHost(baseUrl);
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const caps = data.capabilities;

    if (Array.isArray(caps) && caps.length > 0) return caps.includes("tools");
    // Older Ollama has no capabilities array — sniff the template instead.
    if (typeof data.template === "string") return /\.Tools/.test(data.template);
    return null;
  } catch {
    return null;
  }
}

// Cached model capabilities (e.g. ["completion","tools","thinking","vision"]).
const capsCache = new Map<string, string[]>();
export async function modelCapabilities(baseUrl: string, model: string): Promise<string[]> {
  const k = `${baseUrl}::${model}`;
  if (capsCache.has(k)) return capsCache.get(k)!;
  try {
    const res = await fetch(`${ollamaHost(baseUrl)}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
    capsCache.set(k, caps);
    return caps;
  } catch {
    return [];
  }
}

export async function isOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaHost(baseUrl)}/api/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
