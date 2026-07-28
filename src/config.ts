import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isIncognito } from "./incognito";

export interface Config {
  baseUrl: string;
  apiKey: string;
  // Which inference backend baseUrl points at. "auto" detects it (Ollama via
  // /api/version, vLLM via /version, otherwise a generic OpenAI-compatible
  // server). Pin it when auto-detection is wrong or you want to force native
  // tool-calling (e.g. "vllm"). Affects routing + the tool-calling default.
  provider: "auto" | "ollama" | "vllm" | "openai";
  model: string;
  models: string[];
  maxTokens: number;
  temperature: number;
  cwd: string;
  // Conversation window AND (for Ollama) the num_ctx sent to the server.
  // Defaults to the selected model's FULL NATIVE MAX (the user always wants the
  // highest context available) and is kept in sync with it on every model switch
  // unless pinned. For Ollama, num_ctx's whole KV cache is pre-allocated on load —
  // if a large native context runs slow, quantize the KV cache (OLLAMA_FLASH_ATTENTION=1
  // + OLLAMA_KV_CACHE_TYPE=q8_0) or use vLLM; see recommendContextWindow() for a
  // "what would actually fit fast" estimate surfaced in the fit warning.
  contextWindow: number;
  // True when the user set contextWindow by hand (/config contextWindow <n>) —
  // e.g. deliberately trading context for speed. While pinned, the per-model
  // auto-sync never overrides the value except to LOWER it when it exceeds a
  // model's native limit (an over-native window is rejected/invalid).
  // /config contextWindow auto unpins (back to always-native-max).
  contextWindowPinned: boolean;
  autoCompact: boolean;
  // Stream/show the model's reasoning for thinking-capable models (e.g. gemma3,
  // qwen3). Off = faster, no reasoning. Ignored by non-thinking models.
  thinking: boolean;
  // "auto" detects native tool support per model and falls back to prompted
  // tool-calling when unsupported (e.g. deepseek-coder-v2-lite).
  toolMode: "auto" | "native" | "prompted";
  // Preferred package manager for this project. "auto" = detect from lockfiles
  // (and ask the user when ambiguous). Otherwise the agent is told to use this.
  packageManager: "auto" | "bun" | "npm" | "pnpm" | "yarn";
  // Name of the active coding profile (in ~/.local-cli/profiles/<name>.md) that
  // is injected into every prompt. "" = none selected (auto-use if only one).
  activeProfile: string;
  // Persisted interaction mode. "auto" = the agent runs mutating tools without
  // asking (autonomous); "plan" = research-only; "normal" = prompt per action;
  // "debug" = evidence-driven reproduce→fix→verify loop (asks like normal).
  mode: "normal" | "chat" | "plan" | "auto" | "debug";
  // Tools the user has permanently allowed (via "Always allow" / the CLI's 'a').
  // These never prompt again, even in normal mode. e.g. ["bash"].
  alwaysAllow: string[];
  // Last model used per backend URL, so /backend restores the model you were
  // using there (ollama's "qwen2.5-coder" vs vLLM's "Qwen/…-AWQ" are different
  // names — carrying one across backends breaks with "model not found").
  lastModelByBaseUrl?: Record<string, string>;
  // Auto-stop a response when the model is stuck repeating itself. Off by default
  // — maxTokens already caps a runaway, and esc interrupts manually. Opt in if a
  // model loops badly for you.
  loopGuard: boolean;
  // What to do when the same tool call repeats with an identical result.
  // "warn" (default) nudges the model to change approach and keeps going, so a
  // false positive can't kill real work — the user stops it manually if it's
  // genuinely stuck. "stop" restores the old auto-abort behaviour.
  loopAction: "warn" | "stop";
  // Ollama keep_alive override (e.g. "30m", "-1" = forever). Defaults to "30m"
  // so the model stays resident between turns instead of unloading after
  // Ollama's 5-minute default and paying a full reload on the next message.
  keepAlive?: string;
  // Ollama num_gpu override: how many layers to offload to the GPU. Unset =
  // Ollama decides. Lower it to fit a big model partially; raise to force more
  // onto the GPU when Ollama is being conservative.
  numGpu?: number;
  // Ollama num_thread override for CPU inference. Unset = Ollama decides
  // (physical cores). Set it if Ollama under-uses your CPU.
  numThread?: number;
  // Sandboxed execution for the bash tool: run commands inside a container
  // instead of directly on the host (protects against an agent mistake like
  // rm -rf in auto mode). "none" = run on the host (default).
  sandbox: "none" | "docker" | "podman";
  // Container image used when sandbox is enabled.
  sandboxImage: string;
  // Max fix-and-retest iterations for the /debug autonomous loop.
  debugMaxIterations: number;
  // Maximum loop iterations for a single turn in the chat loop to prevent runaway token spend.
  maxIterations: number;
  // UI color theme preset (see /theme): "mocha" (default), "tokyo", "dark", "light", "mono".
  theme: string;
  // Glyph set (see /icons). "auto" detects the terminal — legacy Windows console
  // (conhost / powershell.exe) gets an ASCII/CP437-safe set so icons don't render
  // as "?"; modern terminals get the rich unicode set. "unicode"/"ascii" force it.
  iconStyle: "auto" | "unicode" | "ascii";
  // Stream watchdog (cold-load / hang resilience). While waiting for the model's
  // first token, emit a "still loading" heartbeat every this-many seconds (0 =
  // off). On a 12 GB-VRAM box a cold load can take a while; this keeps the UI
  // from looking frozen.
  stallHeartbeatSec: number;
  // If the first token doesn't arrive within this-many seconds, abort and retry
  // the turn (the model is warmed first). 0 = never abort. Generous by default so
  // a genuinely slow cold load isn't cut short; a wedged server still recovers.
  stallTimeoutSec: number;
  // Local diffusion server for generate_image. Unset = auto-detect ComfyUI
  // (:8188), an A1111-compatible API (:7860), or SwarmUI (:7801) on localhost.
  // Set it only for a non-default host/port.
  imageBaseUrl?: string;
  // Where generated images are saved. Unset = <cwd>/generated-images.
  imageDir?: string;
  // VRAM handling before an image generation. "auto" (default) reads live free
  // VRAM and only evicts the chat model when the image genuinely won't fit —
  // on a 24 GB card an LLM and SDXL usually coexist, so this is normally a
  // no-op. "always" evicts every time; "never" leaves the GPU alone.
  imageAutoUnload?: "auto" | "always" | "never";
}

// Resolved lazily so tests can isolate their config via LOCAL_CLI_CONFIG_DIR
// (set before the first config access) and never touch the real ~/.local-cli.
export function configDir(): string {
  return process.env.LOCAL_CLI_CONFIG_DIR || join(homedir(), ".local-cli");
}
function configPath(): string {
  return join(configDir(), "config.json");
}

const DEFAULTS: Config = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "ollama",
  provider: "auto",
  model: "qwen3:latest",
  models: ["qwen3:latest", "qwen3.5:latest", "qwen2.5-coder:latest"],
  maxTokens: 16384,
  temperature: 0.3,
  cwd: process.cwd(),
  contextWindow: 32768,
  contextWindowPinned: false,
  autoCompact: true,
  toolMode: "auto",
  thinking: true,
  packageManager: "auto",
  activeProfile: "",
  loopGuard: false,
  loopAction: "warn",
  mode: "normal",
  alwaysAllow: [],
  keepAlive: "30m",
  sandbox: "none",
  sandboxImage: "alpine:latest",
  debugMaxIterations: 10,
  maxIterations: 50,
  theme: "mocha",
  iconStyle: "auto",
  stallHeartbeatSec: 15,
  stallTimeoutSec: 120,
};

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const path = configPath();
  let cfg: Config;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      cfg = { ...DEFAULTS, ...raw };
    } catch {
      cfg = { ...DEFAULTS };
    }
  } else {
    cfg = { ...DEFAULTS };
  }
  _config = cfg;
  return cfg;
}

export function saveConfig(updates: Partial<Config>): Config {
  const cfg = loadConfig();
  _config = { ...cfg, ...updates };
  // In incognito the change applies to this running process (so switching model
  // or mode still works) but never reaches config.json. Leaving incognito calls
  // resetConfigCache(), which re-reads disk and discards these edits.
  if (isIncognito()) return _config;
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(_config, null, 2));
  return _config;
}

// Drop the in-memory cache so the next load re-reads from disk (used by tests
// after pointing LOCAL_CLI_CONFIG_DIR at a fresh directory).
export function resetConfigCache(): void {
  _config = null;
}

// ── Per-backend model memory ──────────────────────────────────────────────────
// Model names are backend-specific ("qwen2.5-coder:latest" on Ollama vs
// "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ" on vLLM), so remember which model was
// used at each baseUrl and restore it when switching back (/backend).
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

export function rememberModelForBaseUrl(baseUrl: string, model: string): void {
  const cfg = loadConfig();
  const map = { ...(cfg.lastModelByBaseUrl ?? {}) };
  map[normalizeBaseUrl(baseUrl)] = model;
  saveConfig({ lastModelByBaseUrl: map });
}

export function recallModelForBaseUrl(baseUrl: string): string | undefined {
  return loadConfig().lastModelByBaseUrl?.[normalizeBaseUrl(baseUrl)];
}

export function getConfig(): Config {
  return loadConfig();
}
