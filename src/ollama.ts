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

// On-disk size (bytes) of an installed model, from /api/tags — a good proxy for
// how much VRAM the weights need. Used by the model-switch fit warning.
export async function modelDiskSize(baseUrl: string, model: string): Promise<number | undefined> {
  try {
    const models = await listOllamaModelsDetailed(baseUrl);
    const base = model.split(":")[0]!;
    return (models.find(m => m.name === model) ?? models.find(m => m.name.startsWith(base)))?.size;
  } catch { return undefined; }
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

// Like listOllamaModelsDetailed, but also fills in each model's NATIVE context
// length (one parallel /api/show per model — local Ollama answers these in
// milliseconds). Used by the model picker and /models so the user can SEE the
// context window they'd get before switching.
export async function listOllamaModelsWithContext(baseUrl: string): Promise<OllamaModelInfo[]> {
  const models = await listOllamaModelsDetailed(baseUrl);
  await Promise.all(models.map(async (m) => {
    const info = await modelInfo(baseUrl, m.name).catch(() => null);
    if (info?.contextLength) m.contextLength = info.contextLength;
    if (info?.capabilities?.length) m.capabilities = info.capabilities;
  }));
  return models;
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

// Build a one-line hint like "7.6B · Q4_K_M · 4.5 GB" from a summary. Flags
// models with no tool support right in the picker so the user can see which
// models can actually act as agents BEFORE switching to one.
export function modelHint(m: OllamaModelInfo): string {
  const parts = [m.parameterSize, m.quantization, formatBytes(m.size), formatCtx(m.contextLength)].filter(Boolean);
  if (m.capabilities && m.capabilities.length > 0 && !m.capabilities.includes("tools")) parts.push("⚠ no tools");
  return parts.join(" · ");
}

// One-line agent-fitness verdict for a model, shown when the user switches to
// it. A model without the "tools" capability can still chat, but it was never
// tuned to act agentically — warn up front instead of letting the user discover
// it mid-task (e.g. deepseek-coder-v2:lite is completion+insert only and will
// lecture the user about fixes instead of editing files).
export async function agentFitnessWarning(baseUrl: string, model: string): Promise<string | null> {
  const info = await modelInfo(baseUrl, model).catch(() => null);
  const caps = info?.capabilities ?? [];
  if (caps.length === 0) return null; // unknown (non-Ollama / old Ollama) — stay quiet
  if (caps.includes("tools")) return null;
  const insertOnly = caps.includes("insert") && !caps.includes("thinking");
  return (
    `⚠ "${model}" has no native tool support (capabilities: ${caps.join(", ")}). ` +
    (insertOnly
      ? "It's a code-completion model, not an agent — expect it to print advice and code snippets instead of editing files, starting servers, or running commands. "
      : "Agentic use falls back to prompted tool-calling, which is unreliable for models not tuned for it. ") +
    "It's fine for questions and autocomplete; for real coding tasks switch to a tools-capable model (e.g. qwen2.5-coder — check /models for the ⚠ no tools flag)."
  );
}

// Models currently LOADED in Ollama's memory (GET /api/ps). size_vram tells how
// much of the model sits on the GPU — when it's less than size, the rest spilled
// into system RAM and generation slows down. Powers the VRAM warnings + the
// "loaded models" panel.
export interface LoadedModel {
  name: string;
  size?: number;       // total bytes the loaded model occupies
  sizeVram?: number;   // bytes of that on the GPU
  expiresAt?: string;  // when Ollama will unload it (keep_alive)
  contextLength?: number;
}

export async function loadedModels(baseUrl: string): Promise<LoadedModel[]> {
  const host = ollamaHost(baseUrl);
  try {
    const res = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.models ?? [])
      .map((m: any): LoadedModel => ({
        name: m.name ?? m.model ?? "",
        size: typeof m.size === "number" ? m.size : undefined,
        sizeVram: typeof m.size_vram === "number" ? m.size_vram : undefined,
        expiresAt: m.expires_at,
        contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      }))
      .filter((m: LoadedModel) => m.name);
  } catch {
    return [];
  }
}

// Render `ollama ps` for the /ps command: one line per resident model with its
// VRAM residency (and a flag when part of it spilled to system RAM, which slows
// generation) and how long until Ollama unloads it. `now` is injectable so the
// relative expiry is testable.
export function formatLoadedModels(models: LoadedModel[], currentModel: string, now = Date.now()): string {
  if (models.length === 0) return "No models are currently resident in Ollama. The model loads on the first message (or run /benchmark to warm it).";
  const gb = (n?: number) => (typeof n === "number" ? (n / 1e9).toFixed(1) + " GB" : "?");
  const expiry = (iso?: string): string => {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const mins = Math.round((t - now) / 60000);
    if (mins <= 0) return "expiring now";
    if (mins >= 525600) return "no expiry";          // keep_alive -1 → far-future date
    if (mins >= 60) return `expires in ${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
    return `expires in ${mins}m`;
  };
  const lines = ["Loaded models (ollama ps):"];
  for (const m of models) {
    const here = m.name === currentModel || m.name.startsWith(currentModel.split(":")[0]!);
    const pct = m.size && m.sizeVram !== undefined ? Math.round((m.sizeVram / m.size) * 100) : null;
    const gpu = pct === null ? "" : pct >= 100 ? "100% on GPU" : `${pct}% on GPU ⚠ rest in RAM (slow)`;
    const ctx = m.contextLength ? `ctx ${m.contextLength}` : "";
    const exp = expiry(m.expiresAt);
    lines.push(`  ${here ? "▸" : " "} ${m.name}   ${gb(m.size)}   ${[gpu, ctx, exp].filter(Boolean).join("   ")}`);
  }
  return lines.join("\n");
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
  const host = ollamaHost(baseUrl);
  if (host.includes("11434") || host.toLowerCase().includes("ollama")) {
    return true;
  }
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch (err: any) {
    if (err?.name === "AbortError" || /fetch failed/i.test(err?.message)) {
      throw err;
    }
    return false;
  }
}

