// Live VRAM accounting and automatic model swapping.
//
// The problem this solves: a diffusion model and an LLM want the same GPU. On a
// 24 GB card most pairs coexist fine (a Q4 9B is ~6 GB, SDXL ~8 GB), so blindly
// unloading the LLM before every image would be a needless 20-second reload. But
// a 35B Q4 with a big KV cache leaves no room, and then generation either OOMs or
// silently spills to system RAM and crawls.
//
// So: measure, then decide. Unload only when the numbers say we have to, and put
// the LLM back afterwards.

import { spawnSync } from "child_process";
import { getConfig } from "./config";
import { loadedModels } from "./ollama";

export interface VramSnapshot {
  totalMB: number;
  usedMB: number;
  freeMB: number;
  source: "nvidia-smi" | "unknown";
}

// nvidia-smi is the only reliable live figure — Ollama's /api/ps reports what IT
// loaded, not what the whole system is using (a browser or a game counts too).
export function vramSnapshot(): VramSnapshot {
  try {
    const r = spawnSync("nvidia-smi",
      ["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf-8", timeout: 6000 });
    const line = (r.stdout ?? "").trim().split("\n")[0];
    if (line) {
      const [total, used, free] = line.split(",").map(s => Number(s.trim()));
      if (Number.isFinite(total) && Number.isFinite(free)) {
        return { totalMB: total!, usedMB: used ?? total! - free!, freeMB: free!, source: "nvidia-smi" };
      }
    }
  } catch { /* no nvidia GPU, or the tool isn't on PATH */ }
  return { totalMB: 0, usedMB: 0, freeMB: 0, source: "unknown" };
}

// Rough VRAM an image model needs, by pixel budget. SDXL at 1024² peaks around
// 10 GB with the VAE decode; SD1.5 at 512² is closer to 4 GB. Deliberately
// generous — under-estimating means an OOM mid-generation.
export function estimateImageVramMB(width = 768, height = 768): number {
  const px = width * height;
  if (px <= 512 * 512) return 4500;
  if (px <= 768 * 768) return 7000;
  if (px <= 1024 * 1024) return 10000;
  return 13000;
}

// How much VRAM Ollama is currently holding, and which models hold it.
export async function ollamaResident(): Promise<{ models: string[]; mb: number }> {
  try {
    const loaded = await loadedModels(getConfig().baseUrl);
    const mb = loaded.reduce((n, m) => n + (m.sizeVram ?? m.size ?? 0), 0) / (1024 * 1024);
    return { models: loaded.map(m => m.name), mb: Math.round(mb) };
  } catch {
    return { models: [], mb: 0 };
  }
}

// Ask Ollama to drop a model right now: a generate call with keep_alive 0 is the
// documented way to evict without restarting the server.
export async function unloadOllamaModel(model: string): Promise<boolean> {
  const host = getConfig().baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    return res.ok;
  } catch { return false; }
}

export interface SwapPlan {
  needed: boolean;              // did we have to free anything?
  reason: string;               // human-readable, shown to the user
  unloaded: string[];           // models evicted
  freeBeforeMB: number;
  freeAfterMB: number;
}

// Free VRAM for an image generation if — and only if — the numbers demand it.
// mode: "auto" measures first; "always" unloads unconditionally; "never" is a
// no-op for people who tuned their own split.
export async function freeVramForImage(
  width: number,
  height: number,
  mode: "auto" | "always" | "never" = "auto",
  onNotice?: (s: string) => void
): Promise<SwapPlan> {
  const need = estimateImageVramMB(width, height);
  const before = vramSnapshot();
  const plan: SwapPlan = { needed: false, reason: "", unloaded: [], freeBeforeMB: before.freeMB, freeAfterMB: before.freeMB };

  if (mode === "never") {
    plan.reason = "Auto-unload is off (imageAutoUnload: \"never\") — generating with whatever VRAM is free.";
    return plan;
  }

  // No GPU telemetry: don't guess. Unloading on a machine that didn't need it is
  // a slow, invisible regression, so "auto" stays its hand and says why.
  if (before.source === "unknown" && mode === "auto") {
    plan.reason = "Couldn't read GPU memory (no nvidia-smi) — generating without touching the LLM.";
    return plan;
  }

  const headroomMB = 1024; // leave a margin for the desktop/compositor
  const enough = before.freeMB >= need + headroomMB;

  if (mode === "auto" && enough) {
    plan.reason = `${(before.freeMB / 1024).toFixed(1)} GB free, image needs ~${(need / 1024).toFixed(1)} GB — no need to unload anything.`;
    return plan;
  }

  const resident = await ollamaResident();
  if (resident.models.length === 0) {
    plan.reason = mode === "always"
      ? "Nothing is loaded in Ollama to unload."
      : `Only ${(before.freeMB / 1024).toFixed(1)} GB free and the image needs ~${(need / 1024).toFixed(1)} GB, but no Ollama model is resident — the VRAM is held by something else.`;
    return plan;
  }

  onNotice?.(`Freeing VRAM for image generation — unloading ${resident.models.join(", ")} (~${(resident.mb / 1024).toFixed(1)} GB). It reloads automatically afterwards.`);
  for (const m of resident.models) {
    if (await unloadOllamaModel(m)) plan.unloaded.push(m);
  }
  // Eviction isn't instant; give the driver a moment before re-measuring.
  await new Promise(r => setTimeout(r, 1500));

  const after = vramSnapshot();
  plan.needed = true;
  plan.freeAfterMB = after.freeMB;
  plan.reason = plan.unloaded.length
    ? `Unloaded ${plan.unloaded.join(", ")} — free VRAM ${(before.freeMB / 1024).toFixed(1)} GB → ${(after.freeMB / 1024).toFixed(1)} GB.`
    : "Tried to unload the LLM but Ollama didn't release it.";
  return plan;
}

// Put the LLM back after the image is done, so the next chat turn doesn't pay a
// cold load. Best-effort and non-blocking by design — a failure here must never
// turn a successful generation into an error.
export async function reloadChatModel(onNotice?: (s: string) => void): Promise<void> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  try {
    const body: any = { model: cfg.model, messages: [], options: { num_ctx: cfg.contextWindow } };
    if (cfg.keepAlive) body.keep_alive = cfg.keepAlive;
    if (typeof cfg.numGpu === "number") body.options.num_gpu = cfg.numGpu;
    await fetch(`${host}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    });
    onNotice?.(`Reloaded ${cfg.model}.`);
  } catch { /* the next turn will load it anyway */ }
}
