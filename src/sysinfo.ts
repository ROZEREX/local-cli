import { spawnSync } from "child_process";
import { cpus, totalmem, freemem, platform, release, arch } from "os";

// Hardware evaluation + per-task model recommendations. Local LLMs are bounded by
// memory (VRAM if you have a GPU, otherwise system RAM), so we detect what's
// available and suggest models that will actually run — coding vs. vision vs.
// general — instead of letting the user pull a model too big for their machine.

export interface Gpu { name: string; vramGB?: number; }
export interface SystemInfo {
  os: string;
  cpu: { model: string; cores: number };
  ramGB: number;
  ramFreeGB: number;
  gpus: Gpu[];
  budgetGB: number;       // memory we can realistically devote to a model
  budgetSource: "gpu" | "ram";
}

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

function detectGpus(): Gpu[] {
  // nvidia-smi is the accurate source of VRAM when present.
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf-8", timeout: 6000 });
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim().split(/\r?\n/).map(line => {
        const [name, mb] = line.split(",").map(s => s.trim());
        return { name: name || "GPU", vramGB: mb ? Math.round((Number(mb) / 1024) * 10) / 10 : undefined };
      });
    }
  } catch {}
  if (platform() === "win32") {
    try {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"], { encoding: "utf-8", timeout: 9000 });
      const data = JSON.parse(r.stdout || "null");
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      // AdapterRAM is a uint32 (caps ~4GB), so it's unreliable for big cards — keep
      // it only as a hint, never above what nvidia-smi would report.
      return arr.filter((g: any) => g?.Name).map((g: any) => ({ name: g.Name, vramGB: g.AdapterRAM > 0 ? Math.round((g.AdapterRAM / 1e9) * 10) / 10 : undefined }));
    } catch {}
  }
  if (platform() === "linux") {
    try {
      const r = spawnSync("sh", ["-c", "lspci | grep -iE 'vga|3d|display'"], { encoding: "utf-8", timeout: 5000 });
      if (r.stdout.trim()) return r.stdout.trim().split(/\r?\n/).map(l => ({ name: l.split(":").slice(2).join(":").trim() || l.trim() }));
    } catch {}
  }
  return [];
}

export function systemInfo(): SystemInfo {
  const c = cpus();
  const gpus = detectGpus();
  const ramGB = gb(totalmem());
  const bestVram = Math.max(0, ...gpus.map(g => g.vramGB ?? 0));
  // A dedicated GPU with known VRAM is the real budget; otherwise fall back to
  // ~70% of system RAM (CPU inference — works, just slower).
  const budget = bestVram >= 2 ? bestVram : Math.round(ramGB * 0.7 * 10) / 10;
  return {
    os: `${platform()} ${release()} (${arch()})`,
    cpu: { model: (c[0]?.model || "CPU").trim(), cores: c.length },
    ramGB, ramFreeGB: gb(freemem()), gpus,
    budgetGB: budget, budgetSource: bestVram >= 2 ? "gpu" : "ram",
  };
}

// Hardware doesn't change during a session, and detection spawns nvidia-smi /
// PowerShell — so memoize it. Used by the model-switch fit warning (don't pay
// the spawn cost on every switch).
let _cachedInfo: SystemInfo | null = null;
export function cachedSystemInfo(): SystemInfo {
  if (!_cachedInfo) _cachedInfo = systemInfo();
  return _cachedInfo;
}

// Proactive warning shown when SELECTING a model whose weights (and/or huge KV
// cache from a large native context) won't fit the memory budget — so the user
// learns it upfront instead of after a 10-minute thrash. Returns null when it
// fits comfortably. Weights are the reliable signal (on-disk size ≈ VRAM use);
// the context note is a qualitative heads-up since exact KV size needs the
// model's head dims.
export function modelFitWarning(modelSizeBytes: number | undefined, nativeContext: number | undefined): string | null {
  const info = cachedSystemInfo();
  const budget = info.budgetGB;
  const weightsGB = modelSizeBytes ? Math.round((modelSizeBytes / 1e9) * 10) / 10 : 0;
  if (!budget || !weightsGB) return null;
  const where = info.budgetSource === "gpu" ? `${budget} GB VRAM` : `~${budget} GB usable RAM`;
  const ctxK = nativeContext ? Math.round(nativeContext / 1024) : 0;

  if (weightsGB > budget * 0.95) {
    const ctxNote = ctxK > 32
      ? ` On top of that, its ${ctxK}k context makes the KV cache huge — shrink it with /config contextWindow 16384.`
      : "";
    return `⚠ "${weightsGB} GB model" vs your ${where}: it won't fully fit, so part runs from system RAM and generation will be very slow (this is what made it hang).${ctxNote} For smooth local work pick a model that fits — see /system (e.g. qwen2.5-coder:7b or qwen3:8b).`;
  }
  if (ctxK > 64 && weightsGB > budget * 0.6) {
    return `Note: the model fits your ${where}, but its ${ctxK}k context adds a large KV cache that can spill to RAM and slow generation. If it drags, lower it: /config contextWindow 32768.`;
  }
  return null;
}

// Per-task recommendations. minGB ≈ memory a Q4 build needs (VRAM, or RAM on CPU).
interface Rec { name: string; minGB: number; note?: string; }
const RECS: Record<"coding" | "vision" | "general", Rec[]> = {
  coding: [
    { name: "qwen2.5-coder:3b", minGB: 3, note: "light, still solid for code" },
    { name: "qwen2.5-coder:7b", minGB: 6, note: "best all-round local coder" },
    { name: "qwen2.5-coder:14b", minGB: 10 },
    { name: "deepseek-coder-v2:16b", minGB: 11 },
    { name: "qwen2.5-coder:32b", minGB: 20, note: "top quality if it fits" },
  ],
  vision: [
    { name: "moondream", minGB: 3, note: "tiny, fast image captions" },
    { name: "llava:7b", minGB: 6 },
    { name: "qwen2.5vl:7b", minGB: 7, note: "strong vision + text" },
    { name: "llama3.2-vision:11b", minGB: 9 },
  ],
  general: [
    { name: "qwen3:4b", minGB: 4 },
    { name: "qwen3:8b", minGB: 6, note: "good reasoning, has tools" },
    { name: "gemma3:12b", minGB: 9 },
    { name: "qwen3:14b", minGB: 11 },
  ],
};

export interface TaskRec { task: string; best: string | null; note: string; options: { name: string; fits: boolean; note?: string }[]; }

export function recommendModels(info: SystemInfo): TaskRec[] {
  const budget = info.budgetGB;
  return (Object.keys(RECS) as (keyof typeof RECS)[]).map(task => {
    const options = RECS[task].map(r => ({ name: r.name, fits: r.minGB <= budget, note: r.note }));
    const fitting = RECS[task].filter(r => r.minGB <= budget);
    const best = fitting.length ? fitting[fitting.length - 1]!.name : RECS[task][0]!.name;
    const note = fitting.length
      ? `recommended: ${best}`
      : `nothing fits your ~${budget} GB budget comfortably; smallest option is ${RECS[task][0]!.name}`;
    return { task, best: fitting.length ? best : null, note, options };
  });
}

// Human-readable summary for the system_info tool / CLI / web panel.
export function describeSystem(info: SystemInfo, recs: TaskRec[]): string {
  const lines: string[] = [];
  lines.push(`OS:   ${info.os}`);
  lines.push(`CPU:  ${info.cpu.model} (${info.cpu.cores} cores)`);
  lines.push(`RAM:  ${info.ramGB} GB total, ${info.ramFreeGB} GB free`);
  if (info.gpus.length) for (const g of info.gpus) lines.push(`GPU:  ${g.name}${g.vramGB ? ` (${g.vramGB} GB VRAM)` : " (VRAM unknown)"}`);
  else lines.push("GPU:  none detected (CPU inference)");
  lines.push(`Model memory budget: ~${info.budgetGB} GB (${info.budgetSource === "gpu" ? "GPU VRAM" : "system RAM, CPU inference — slower"})`);
  lines.push("");
  lines.push("Recommended models per task (pull with: ollama pull <name>):");
  for (const r of recs) {
    const label = r.task === "coding" ? "Coding " : r.task === "vision" ? "Vision " : "General";
    lines.push(`  ${label}: ${r.best ? r.best + "  ✓" : r.options[0]!.name + "  ⚠ tight"}`);
  }
  if (info.budgetSource === "ram") lines.push("\nTip: no usable GPU detected — models will run on CPU (slower). A GPU with 8+ GB VRAM is recommended for smooth 7B models.");
  return lines.join("\n");
}
