import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  maxTokens: number;
  temperature: number;
  cwd: string;
  contextWindow: number;
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
  // asking (autonomous); "plan" = research-only; "normal" = prompt per action.
  mode: "normal" | "plan" | "auto";
  // Auto-stop a response when the model is stuck repeating itself. Off by default
  // — maxTokens already caps a runaway, and esc interrupts manually. Opt in if a
  // model loops badly for you.
  loopGuard: boolean;
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
  model: "qwen3:latest",
  models: ["qwen3:latest", "qwen3.5:latest", "qwen2.5-coder:latest"],
  maxTokens: 16384,
  temperature: 0.3,
  cwd: process.cwd(),
  contextWindow: 32768,
  autoCompact: true,
  toolMode: "auto",
  thinking: true,
  packageManager: "auto",
  activeProfile: "",
  loopGuard: false,
  mode: "normal",
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

export function getConfig(): Config {
  return loadConfig();
}
