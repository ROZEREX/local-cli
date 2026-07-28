// Local image generation. Same philosophy as the rest of this CLI: the model
// runs on YOUR machine, so this talks to a local diffusion server rather than a
// hosted API. Nothing here needs an API key and nothing leaves the box.
//
// Ollama cannot generate images (it serves LLMs/VLMs only), so this speaks to
// whichever diffusion server you already run. Three families cover essentially
// every local setup:
//   • A1111-compatible  — AUTOMATIC1111, Forge, reForge, SD.Next  (:7860)
//   • ComfyUI           — graph API                               (:8188)
//   • SwarmUI           — ComfyUI front end with its own REST API  (:7801)
// Detection is by probing, so starting any of them just works with no config.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { getConfig } from "./config";
import { freeVramForImage, reloadChatModel, type SwapPlan } from "./vram";

export type ImageBackendKind = "a1111" | "comfyui" | "swarmui";

export interface ImageBackend {
  kind: ImageBackendKind;
  baseUrl: string;
  label: string;
}

export interface GenerateOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  model?: string;
  outPath?: string;
}

export interface GenerateResult {
  path: string;
  backend: ImageBackend;
  seed?: number;
  width: number;
  height: number;
  elapsedMs: number;
  swap: SwapPlan;
}

const PROBES: { kind: ImageBackendKind; url: string; path: string; label: string }[] = [
  { kind: "a1111", url: "http://127.0.0.1:7860", path: "/sdapi/v1/options", label: "AUTOMATIC1111 / Forge / SD.Next" },
  { kind: "comfyui", url: "http://127.0.0.1:8188", path: "/system_stats", label: "ComfyUI" },
  { kind: "swarmui", url: "http://127.0.0.1:7801", path: "/API/GetNewSession", label: "SwarmUI" },
];

async function alive(url: string, path: string, method = "GET"): Promise<boolean> {
  try {
    const res = await fetch(url + path, { method, signal: AbortSignal.timeout(1500), ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}) });
    return res.ok;
  } catch { return false; }
}

// Find a running backend. An explicit config.imageBaseUrl wins and is probed
// against each protocol so a non-default port still resolves to the right kind.
export async function detectImageBackend(): Promise<ImageBackend | null> {
  const configured = (getConfig() as any).imageBaseUrl as string | undefined;
  if (configured) {
    const base = configured.replace(/\/+$/, "");
    for (const p of PROBES) {
      if (await alive(base, p.path, p.kind === "swarmui" ? "POST" : "GET")) {
        return { kind: p.kind, baseUrl: base, label: p.label };
      }
    }
    return null;
  }
  for (const p of PROBES) {
    if (await alive(p.url, p.path, p.kind === "swarmui" ? "POST" : "GET")) {
      return { kind: p.kind, baseUrl: p.url, label: p.label };
    }
  }
  return null;
}

// Where a generated image lands when the caller didn't name a path.
function defaultOutPath(prompt: string): string {
  const cfg = getConfig();
  const dir = (cfg as any).imageDir || join(cfg.cwd, "generated-images");
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(dir, `${stamp}_${slug}.png`);
}

function writePng(outPath: string, base64: string): void {
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
}

// ── A1111-compatible ─────────────────────────────────────────────────────────
async function generateA1111(b: ImageBackend, o: GenerateOptions, signal?: AbortSignal): Promise<{ base64: string; seed?: number }> {
  const body: Record<string, unknown> = {
    prompt: o.prompt,
    negative_prompt: o.negativePrompt ?? "",
    width: o.width ?? 768,
    height: o.height ?? 768,
    steps: o.steps ?? 25,
    cfg_scale: o.cfgScale ?? 7,
    seed: o.seed ?? -1,
    sampler_name: "DPM++ 2M",
  };
  if (o.model) (body as any).override_settings = { sd_model_checkpoint: o.model };

  const res = await fetch(`${b.baseUrl}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${b.label} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const image = json?.images?.[0];
  if (!image) throw new Error(`${b.label} returned no image.`);
  let seed: number | undefined;
  try { seed = JSON.parse(json.info)?.seed; } catch {}
  return { base64: image, seed };
}

// ── ComfyUI ──────────────────────────────────────────────────────────────────
// ComfyUI has no "just make me an image" endpoint — it executes a node graph. We
// post a minimal standard SD txt2img graph, poll the history for completion, and
// download the produced file. The checkpoint has to be named; if the caller
// didn't, we take the first one ComfyUI reports.
async function comfyCheckpoint(b: ImageBackend, preferred?: string): Promise<string> {
  if (preferred) return preferred;
  const res = await fetch(`${b.baseUrl}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error("Could not list ComfyUI checkpoints.");
  const info: any = await res.json();
  const list = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(list) || list.length === 0) throw new Error("ComfyUI has no checkpoints installed — add a model to ComfyUI/models/checkpoints.");
  return list[0];
}

function comfyGraph(o: GenerateOptions, ckpt: string, seed: number) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: o.width ?? 768, height: o.height ?? 768, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: o.prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: o.negativePrompt ?? "", clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed, steps: o.steps ?? 25, cfg: o.cfgScale ?? 7,
        sampler_name: "dpmpp_2m", scheduler: "normal", denoise: 1,
        model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "local-cli", images: ["8", 0] } },
  };
}

async function generateComfy(b: ImageBackend, o: GenerateOptions, signal?: AbortSignal): Promise<{ base64: string; seed?: number }> {
  const ckpt = await comfyCheckpoint(b, o.model);
  const seed = o.seed && o.seed > 0 ? o.seed : Math.floor(Math.random() * 2 ** 31);
  const clientId = `local-cli-${Date.now()}`;

  const queued = await fetch(`${b.baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: comfyGraph(o, ckpt, seed), client_id: clientId }),
    signal,
  });
  if (!queued.ok) throw new Error(`ComfyUI rejected the graph (HTTP ${queued.status}): ${(await queued.text()).slice(0, 300)}`);
  const promptId = (await queued.json() as any)?.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt id.");

  // Poll history. Diffusion on a busy GPU can take a while, so this is patient.
  for (let i = 0; i < 600; i++) {
    if (signal?.aborted) throw new Error("Aborted.");
    await new Promise(r => setTimeout(r, 500));
    const h = await fetch(`${b.baseUrl}/history/${promptId}`, { signal }).catch(() => null);
    if (!h?.ok) continue;
    const hist: any = await h.json();
    const entry = hist?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error("ComfyUI reported an execution error — check its console.");
    const images = Object.values(entry.outputs ?? {}).flatMap((out: any) => out?.images ?? []);
    const img: any = images[0];
    if (!img) continue;
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
    const file = await fetch(`${b.baseUrl}/view?${q}`, { signal });
    if (!file.ok) throw new Error("ComfyUI produced an image but it could not be downloaded.");
    return { base64: Buffer.from(await file.arrayBuffer()).toString("base64"), seed };
  }
  throw new Error("ComfyUI did not finish within 5 minutes.");
}

// ── SwarmUI ──────────────────────────────────────────────────────────────────
async function generateSwarm(b: ImageBackend, o: GenerateOptions, signal?: AbortSignal): Promise<{ base64: string; seed?: number }> {
  const s = await fetch(`${b.baseUrl}/API/GetNewSession`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
  });
  if (!s.ok) throw new Error(`SwarmUI session request failed (HTTP ${s.status}).`);
  const sessionId = (await s.json() as any)?.session_id;
  if (!sessionId) throw new Error("SwarmUI did not return a session id.");

  const seed = o.seed && o.seed > 0 ? o.seed : Math.floor(Math.random() * 2 ** 31);
  const res = await fetch(`${b.baseUrl}/API/GenerateText2Image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId, images: 1, prompt: o.prompt, negativeprompt: o.negativePrompt ?? "",
      width: o.width ?? 768, height: o.height ?? 768, steps: o.steps ?? 25, cfgscale: o.cfgScale ?? 7,
      seed, ...(o.model ? { model: o.model } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`SwarmUI returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const first = json?.images?.[0];
  if (!first) throw new Error(`SwarmUI returned no image${json?.error ? `: ${json.error}` : "."}`);
  // SwarmUI returns either a data URI or a path relative to its output route.
  if (typeof first === "string" && first.startsWith("data:")) return { base64: first, seed };
  const file = await fetch(`${b.baseUrl}/${String(first).replace(/^\/+/, "")}`, { signal });
  if (!file.ok) throw new Error("SwarmUI produced an image but it could not be downloaded.");
  return { base64: Buffer.from(await file.arrayBuffer()).toString("base64"), seed };
}

// ── public entry point ───────────────────────────────────────────────────────
export async function generateImage(
  o: GenerateOptions,
  signal?: AbortSignal,
  onNotice?: (s: string) => void
): Promise<GenerateResult> {
  if (!o.prompt?.trim()) throw new Error("A prompt is required.");
  const backend = await detectImageBackend();
  if (!backend) throw new Error(NO_BACKEND_MESSAGE);

  const width = o.width ?? 768;
  const height = o.height ?? 768;

  // Make room on the GPU first — but only if the live numbers say we must. See
  // src/vram.ts: on a 24 GB card an LLM and SDXL usually coexist, and an
  // unnecessary unload costs a slow reload for nothing.
  const mode = ((getConfig() as any).imageAutoUnload ?? "auto") as "auto" | "always" | "never";
  const plan = await freeVramForImage(width, height, mode, onNotice);
  if (plan.reason) onNotice?.(plan.reason);

  const started = Date.now();
  const gen =
    backend.kind === "a1111" ? generateA1111 :
    backend.kind === "comfyui" ? generateComfy :
    generateSwarm;

  let out: { base64: string; seed?: number };
  try {
    out = await gen(backend, o, signal);
  } finally {
    // Whether generation succeeded or blew up, put the chat model back if we
    // were the ones who evicted it.
    if (plan.unloaded.length) void reloadChatModel(onNotice);
  }

  const outPath = o.outPath ? resolve(getConfig().cwd, o.outPath) : defaultOutPath(o.prompt);
  writePng(outPath, out.base64);
  return {
    path: outPath, backend, seed: out.seed, width, height,
    elapsedMs: Date.now() - started,
    swap: plan,
  };
}

export const NO_BACKEND_MESSAGE =
  `No local image-generation server is running.\n\n` +
  `Image models are diffusion models — Ollama and vLLM serve LLMs and can't produce images — so one of these needs to be running:\n` +
  `  • ComfyUI (lightest, most flexible): start it, then it listens on http://127.0.0.1:8188\n` +
  `  • AUTOMATIC1111 / Forge / SD.Next: launch with --api so http://127.0.0.1:7860/sdapi/v1/txt2img is available\n` +
  `  • SwarmUI: http://127.0.0.1:7801\n\n` +
  `Any of them is detected automatically once it's up — no configuration needed. ` +
  `On a non-default port, set imageBaseUrl in ~/.local-cli/config.json.\n\n` +
  `VRAM is handled automatically: before generating, free VRAM is measured and the chat model is evicted ` +
  `only if the image genuinely won't fit, then reloaded afterwards (imageAutoUnload: auto | always | never).`;
