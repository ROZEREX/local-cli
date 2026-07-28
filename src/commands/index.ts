import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getConfig, saveConfig, rememberModelForBaseUrl, recallModelForBaseUrl } from "../config";
import { resetClient, estimateTokens } from "../llm";
import { findProjectContext } from "../context";
import { listModelsForPicker, detectProvider, modelInfo, modelHint, formatCtx, agentFitnessWarning, loadedModels, isOllama, formatLoadedModels } from "../ollama";
import {
  readProfileByName, listProfileNames, getActiveProfileName, setActiveProfile,
  deleteProfileByName, detectPackageManager, resolvePackageManager,
} from "../profile";
import { listServersTool, stopServerTool, listPortsTool, killPortTool, systemInfoTool } from "../tools/executor";
import { undoLast, describeHistory } from "../history";
import { readMemory, addMemory, forgetMemory, clearMemory } from "../memory";
import { describeTasks, addTask, completeTask, removeDoneTasks, clearTasks } from "../tasks";
import { formatSessionTodos, clearSessionTodos, getSessionTodos } from "../todos";
import { ensureIndex, searchCode, formatSearchResults } from "../search";
import { describeIndex } from "../indexer";
import { runSubAgents, formatAgentResults } from "../agents";
import { applyTheme, themeNames, applyIconStyle, detectIconStyle } from "../ui/theme";
import type { Mode } from "../prompt";
import type { Config } from "../config";

export interface CommandContext {
  history: ChatCompletionMessageParam[];
  // Print a block of text into the transcript (the UI styles it).
  print: (text: string, tone?: "info" | "error") => void;
  clearHistory: () => void;
  exit: () => void;
  // Mode (normal / plan).
  mode: Mode;
  setMode: (m: Mode) => void;
  // Context / session / token management — implemented by the App.
  compact: () => Promise<void>;
  saveSession: () => void;
  resume: (id?: string) => void;
  openModelPicker: () => void;
  openSessionPicker: () => void;
  openFiles: () => void;
  addPaths: (paths: string[]) => void;
  runInit: () => void;
  // Run the agent to learn the user's coding style and write a named profile.
  learnProfile: (name?: string) => void;
  // Open the picker to choose which saved profile is active.
  openProfilePicker: () => void;
  // Run the agent on a canned instruction (used by /review, /debug, …).
  runAgent: (display: string, instruction: string) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  run: (args: string[], ctx: CommandContext) => void | Promise<void>;
}

// Quick reachability probe for a backend URL — metadata endpoints only, never
// loads a model. Identifies what's actually running there and how many models
// it serves, so /backend can show live status before you switch.
async function probeBackend(url: string): Promise<{ kind: "ollama" | "vllm" | "openai"; models: number } | null> {
  const host = url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  try {
    const r = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const tags: any = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) }).then(x => x.json()).catch(() => null);
      return { kind: "ollama", models: tags?.models?.length ?? 0 };
    }
  } catch { /* not ollama or down — try the OpenAI shape */ }
  try {
    const res = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const models: any = await res.json();
    if (!Array.isArray(models?.data)) return null;
    let kind: "vllm" | "openai" = "openai";
    try {
      const v = await fetch(`${host}/version`, { signal: AbortSignal.timeout(1500) });
      if (v.ok) kind = "vllm";
    } catch { /* plain OpenAI-compatible */ }
    return { kind, models: models.data.length };
  } catch {
    return null;
  }
}

const BACKEND_DEFAULT_URL: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
  vllm: "http://localhost:8000/v1",
};

const commands: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run: (_args, ctx) => {
      // Grouped like a real CLI's help screen — 45 commands in one flat list is
      // unreadable. Names not in the map land in "other" so a new command never
      // silently disappears from help.
      const GROUPS: [string, string[]][] = [
        ["backend & models", ["backend", "model", "models", "modelinfo", "ps", "benchmark", "think"]],
        ["chat & sessions", ["new", "chats", "sessions", "resume", "save", "compact", "clear", "tokens", "export"]],
        ["context & project", ["add", "context", "init", "cwd", "memory", "tasks", "task", "index", "search", "pm"]],
        ["working modes", ["plan", "debug", "agents", "todos", "allow", "undo", "sandbox"]],
        ["workflows", ["review", "commit", "test", "fix", "explain", "security"]],
        ["profiles", ["learn", "profiles", "profile", "delprofile"]],
        ["servers & system", ["servers", "ports", "browser", "system"]],
        ["appearance & setup", ["theme", "icons", "config"]],
      ];
      const grouped = new Set(GROUPS.flatMap(([, names]) => names));
      const byName = new Map(commands.map(c => [c.name, c]));
      const width = Math.max(...commands.map(c => c.name.length)) + 1;
      const lines: string[] = [];
      const section = (title: string, names: string[]) => {
        const present = names.map(n => byName.get(n)).filter(Boolean) as SlashCommand[];
        if (!present.length) return;
        lines.push(`${title}`);
        for (const c of present) lines.push(`  /${c.name.padEnd(width)} ${c.description}`);
        lines.push("");
      };
      for (const [title, names] of GROUPS) section(title, names);
      section("other", commands.map(c => c.name).filter(n => !grouped.has(n) && n !== "help" && n !== "exit"));
      lines.push("shift+tab toggles plan mode · @file attaches a file · esc interrupts · /exit quits");
      ctx.print(lines.join("\n"));
    },
  },
  {
    name: "plan",
    description: "Toggle plan mode (research & propose before acting)",
    run: (_args, ctx) => {
      const next: Mode = ctx.mode === "plan" ? "normal" : "plan";
      ctx.setMode(next);
      ctx.print(next === "plan"
        ? "Plan mode ON — I'll research and propose a plan without changing anything."
        : "Plan mode OFF — back to normal (acting) mode.");
    },
  },
  {
    name: "chat",
    description: "Toggle chat mode (talk only — never creates or edits files)",
    run: (_args, ctx) => {
      const next: Mode = ctx.mode === "chat" ? "normal" : "chat";
      ctx.setMode(next);
      ctx.print(next === "chat"
        ? "Chat mode ON — I'll answer in the conversation. Ask for a list and you get a list, not a file. write_file/edit_file/bash are blocked."
        : "Chat mode OFF — back to normal (acting) mode.");
    },
  },
  {
    name: "model",
    description: "Pick a model, or set one:  /model <name>",
    run: (args, ctx) => {
      if (args.length === 0) { ctx.openModelPicker(); return; }
      saveConfig({ model: args[0] });
      rememberModelForBaseUrl(getConfig().baseUrl, args[0]!);
      resetClient();
      ctx.print(`Model set to ${args[0]}`);
      // Warn up front if this model can't act as an agent (best-effort, async).
      void agentFitnessWarning(getConfig().baseUrl, args[0]!)
        .then(w => { if (w) ctx.print(w); })
        .catch(() => {});
    },
  },
  {
    name: "models",
    description: "List models served by the current backend (Ollama / vLLM)",
    run: async (_args, ctx) => {
      const cfg = getConfig();
      try {
        const provider = await detectProvider(cfg.baseUrl, cfg.provider);
        const live = await listModelsForPicker(cfg.baseUrl, cfg.provider);
        if (live.length) {
          const width = Math.max(...live.map(m => m.name.length));
          const header = provider === "ollama" ? "Installed models (ollama list):"
            : provider === "vllm" ? "Models served by vLLM (/v1/models):"
            : "Models served by the endpoint (/v1/models):";
          const tip = provider === "ollama"
            ? "\n\nTip: /modelinfo [name] for context length & capabilities."
            : "";
          ctx.print(
            header + "\n" +
            live.map(m => {
              const hint = modelHint(m);
              return `  ${m.name === cfg.model ? "●" : " "} ${m.name.padEnd(width)}${hint ? "   " + hint : ""}`;
            }).join("\n") + tip
          );
          return;
        }
        ctx.print(provider === "ollama"
          ? "Ollama reported no models. Pull one with: ollama pull <name>"
          : "The endpoint reported no models at /v1/models.");
      } catch {
        ctx.print(`Couldn't reach the backend at ${cfg.baseUrl}. Configured fallback:\n` + cfg.models.map(m => `  ${m === cfg.model ? "● " : "  "}${m}`).join("\n"), "error");
      }
    },
  },
  {
    name: "modelinfo",
    description: "Full details for a model (ctx, params, caps):  /modelinfo [name]",
    run: async (args, ctx) => {
      const cfg = getConfig();
      const target = args[0] ?? cfg.model;
      const info = await modelInfo(cfg.baseUrl, target);
      if (!info) {
        ctx.print(`Couldn't load details for "${target}". Is Ollama running and the model installed?`, "error");
        return;
      }
      const ctxLine = info.contextLength
        ? `${info.contextLength.toLocaleString()} tokens (${formatCtx(info.contextLength)})`
        : "unknown";
      const lines = [
        `Model: ${info.name}${info.name === cfg.model ? "  ● current" : ""}`,
        `  Parameters:    ${info.parameterSize ?? "unknown"}`,
        `  Quantization:  ${info.quantization ?? "unknown"}`,
        `  Family:        ${info.family ?? "unknown"}`,
        `  Native context:${" "}${ctxLine}`,
        `  Capabilities:  ${info.capabilities?.length ? info.capabilities.join(", ") : "none reported"}`,
      ];
      if (info.contextLength && cfg.contextWindow > info.contextLength) {
        lines.push("");
        lines.push(`  ⚠ Your contextWindow (${cfg.contextWindow.toLocaleString()}) exceeds this model's native ${info.contextLength.toLocaleString()}. Lower it with /config contextWindow ${info.contextLength}.`);
      }
      ctx.print(lines.join("\n"));
    },
  },
  {
    name: "backend",
    description: "Show reachable backends or switch:  /backend [ollama|vllm|<url>]",
    run: async (args, ctx) => {
      const cfg = getConfig();

      if (args.length === 0) {
        // Status view: probe the current URL plus the two well-known local
        // defaults (deduped), so you can SEE what's up before switching.
        const norm = (u: string) => u.replace(/\/+$/, "");
        const urls = [...new Set([cfg.baseUrl, BACKEND_DEFAULT_URL.ollama!, BACKEND_DEFAULT_URL.vllm!].map(norm))];
        const probes = await Promise.all(urls.map(u => probeBackend(u)));
        const lines = ["Backends:"];
        urls.forEach((u, i) => {
          const p = probes[i];
          const here = u === norm(cfg.baseUrl);
          const mark = here ? "●" : " ";
          lines.push(p
            ? `  ${mark} ${p.kind.padEnd(6)} ${u}   ✓ up · ${p.models} model${p.models === 1 ? "" : "s"}${here ? "   ← current" : ""}`
            : `  ${mark} ${"—".padEnd(6)} ${u}   ✗ down${here ? "   ← current (unreachable — switch or start it!)" : ""}`);
        });
        lines.push("");
        lines.push("Switch: /backend ollama · /backend vllm · /backend <url>");
        lines.push('Start vLLM (WSL): wsl bash -lc "nohup ~/serve-vllm.sh > ~/vllm-serve.log 2>&1 &"');
        ctx.print(lines.join("\n"));
        return;
      }

      const kind = args[0]!.toLowerCase();
      let url: string;
      let provider: Config["provider"];
      let apiKey: string | undefined;
      if (kind === "ollama" || kind === "vllm") {
        url = args[1] ?? BACKEND_DEFAULT_URL[kind]!;
        provider = kind;
        apiKey = kind; // local servers ignore the key; keep it descriptive
      } else if (/^https?:\/\//i.test(args[0]!)) {
        url = args[0]!;
        provider = "auto";
      } else {
        ctx.print(`Unknown backend "${args[0]}". Use: /backend ollama [url] · /backend vllm [url] · /backend <url>`, "error");
        return;
      }

      // Remember the model used on the backend we're LEAVING, then switch
      // atomically: baseUrl + provider + (restored) model in one save, so no
      // half-switched state can break the next message.
      rememberModelForBaseUrl(cfg.baseUrl, cfg.model);
      const remembered = recallModelForBaseUrl(url);
      const updates: Partial<Config> = { baseUrl: url, provider };
      if (apiKey) updates.apiKey = apiKey;
      if (remembered) updates.model = remembered;
      saveConfig(updates);
      resetClient();

      const p = await probeBackend(url);
      const label = provider === "auto" ? (p?.kind ?? "auto-detect") : provider;
      const lines = [`Backend → ${label} at ${url}`];
      if (remembered) lines.push(`Model restored: ${remembered}`);
      if (!p) {
        lines.push("⚠ Nothing is answering there yet — start the server, then just send a message.");
        if (label === "vllm") lines.push('  Start vLLM (WSL): wsl bash -lc "nohup ~/serve-vllm.sh > ~/vllm-serve.log 2>&1 &"');
        if (label === "ollama") lines.push("  Ollama usually runs as a service — check it with: ollama list");
      }
      ctx.print(lines.join("\n"));
      // No model remembered for this backend: pick from what it actually serves.
      if (!remembered && p) ctx.openModelPicker();
    },
  },
  {
    name: "learn",
    description: "Learn your coding style from this project into a named profile:  /learn [name]",
    run: (args, ctx) => ctx.learnProfile(args[0]),
  },
  {
    name: "profiles",
    description: "Pick which saved coding profile is active (web, desktop, mobile…)",
    run: (_args, ctx) => ctx.openProfilePicker(),
  },
  {
    name: "profile",
    description: "Show a coding profile:  /profile [name]   (defaults to the active one)",
    run: (args, ctx) => {
      const names = listProfileNames();
      if (names.length === 0) {
        ctx.print("No coding profiles yet. Run /learn <name> in a project that represents your style (e.g. /learn web).");
        return;
      }
      const active = getActiveProfileName();
      const name = args[0] || active || names[0]!;
      const p = readProfileByName(name);
      const header = `Profiles: ${names.map(n => (n === active ? `${n} (active)` : n)).join(", ")}\n`;
      if (p) ctx.print(`${header}\n── ${name} ──\n${p}`);
      else ctx.print(`${header}\nProfile "${name}" not found. Use one of: ${names.join(", ")}`);
    },
  },
  {
    name: "delprofile",
    description: "Delete a saved coding profile:  /delprofile <name>",
    run: (args, ctx) => {
      const name = args[0];
      if (!name) { ctx.print("Usage: /delprofile <name>. Existing: " + (listProfileNames().join(", ") || "(none)"), "error"); return; }
      const ok = deleteProfileByName(name);
      ctx.print(ok ? `Deleted profile "${name}".` : `No profile named "${name}".`, ok ? undefined : "error");
    },
  },
  {
    name: "pm",
    description: "Show or set the package manager:  /pm auto|bun|npm|pnpm|yarn",
    run: (args, ctx) => {
      const cfg = getConfig();
      const valid = ["auto", "bun", "npm", "pnpm", "yarn"];
      if (args.length === 0) {
        const { pm, source } = resolvePackageManager(cfg.cwd);
        const detected = detectPackageManager(cfg.cwd);
        ctx.print(
          [
            `Package manager setting: ${cfg.packageManager}`,
            `In this project: ${pm ?? "unknown"}${source === "detected" ? " (detected from lockfile)" : source === "config" ? " (from your setting)" : " (no lockfile — I'll ask before installing)"}`,
            detected ? `Lockfile detected: ${detected}` : "No lockfile found here.",
            "",
            "Set with: /pm auto|bun|npm|pnpm|yarn   (auto = detect per project)",
          ].join("\n")
        );
        return;
      }
      const choice = (args[0] ?? "").toLowerCase();
      if (!valid.includes(choice)) {
        ctx.print(`Invalid: "${choice}". Choose one of: ${valid.join(", ")}`, "error");
        return;
      }
      saveConfig({ packageManager: choice as Config["packageManager"] });
      ctx.print(choice === "auto"
        ? "Package manager set to auto — I'll detect it per project from the lockfile."
        : `Package manager set to ${choice} — I'll use it for installs and scripts.`);
    },
  },
  {
    name: "servers",
    description: "List background servers, or stop one:  /servers stop <id>",
    run: (args, ctx) => {
      if (args[0] === "stop") {
        ctx.print(stopServerTool({ id: args[1] }));
        return;
      }
      ctx.print(listServersTool());
    },
  },
  {
    name: "system",
    description: "Show hardware (CPU/RAM/GPU) and recommended models for your machine",
    run: (_args, ctx) => ctx.print(systemInfoTool()),
  },
  {
    name: "browser",
    description: "Guide: how the agent uses browsers (its own + your live one)",
    run: (_args, ctx) => {
      ctx.print([
        "Browser control — the agent can drive a browser two ways:",
        "",
        "1) ITS OWN browser (no setup) — for testing what it builds.",
        "   It launches a separate Chrome/Edge window and uses browser_open /",
        "   browser_read / browser_click / browser_type / browser_scroll /",
        "   browser_screenshot. You see an animated AI cursor with a click/type",
        "   label and element highlights in that window. In the web UI, the",
        "   Browser tab streams it LIVE while it works.",
        "   Try: \"start my app, open it in the browser and check the layout\"",
        "",
        "2) YOUR live browser (extension, one-time setup) — for real sites.",
        "   Setup: bun run web → chrome://extensions → Developer mode →",
        "   Load unpacked → select this repo's extension/ folder.",
        "   A ◆ bubble appears on pages (green dot = connected). The agent then",
        "   uses page_open / page_read / page_find / page_click / page_type /",
        "   page_highlight on the tab YOU are looking at — same cursor +",
        "   highlights, on your real session (logins included).",
        "   Try: \"open amazon.com and highlight the cheapest mechanical keyboard\"",
        "",
        "Safety: in normal mode it asks before every click/type; auto mode acts",
        "alone — careful on pages with real forms or purchases.",
      ].join("\n"));
    },
  },
  {
    name: "ports",
    description: "List listening ports, or free one:  /ports kill <port>",
    run: (args, ctx) => {
      if (args[0] === "kill" && args[1]) { ctx.print(killPortTool({ port: args[1] })); return; }
      ctx.print(listPortsTool());
    },
  },
  {
    name: "allow",
    description: "Always-allow a tool (no more prompts):  /allow bash  ·  /allow clear  ·  /allow (list)",
    run: (args, ctx) => {
      const cfg = getConfig();
      const cur = cfg.alwaysAllow ?? [];
      if (args.length === 0) {
        ctx.print(cur.length ? `Always-allowed tools (no prompt): ${cur.join(", ")}\nAdd with /allow <tool>, clear with /allow clear.` : "No tools are always-allowed yet. /allow bash to stop being asked about bash.");
        return;
      }
      if (args[0] === "clear") { saveConfig({ alwaysAllow: [] }); ctx.print("Cleared the always-allow list — mutating tools will prompt again."); return; }
      const tool = args[0]!;
      if (cur.includes(tool)) { ctx.print(`${tool} is already always-allowed.`); return; }
      saveConfig({ alwaysAllow: [...cur, tool] });
      ctx.print(`${tool} is now always-allowed — I won't ask before running it. (/allow clear to undo.)`);
    },
  },
  {
    name: "think",
    description: "Toggle showing the model's reasoning:  /think on|off",
    run: (args, ctx) => {
      const cur = getConfig().thinking !== false;
      const next = args[0] ? args[0].toLowerCase() === "on" : !cur;
      saveConfig({ thinking: next });
      ctx.print(next
        ? "Thinking ON — the model's reasoning will stream (dimmed). Slower, but you see what it's doing."
        : "Thinking OFF — faster; reasoning is hidden. (Only affects thinking-capable models.)");
    },
  },
  {
    name: "compact",
    description: "Summarize & shrink the conversation to save tokens",
    run: async (_args, ctx) => {
      await ctx.compact();
    },
  },
  {
    name: "save",
    description: "Save the current session",
    run: (_args, ctx) => {
      ctx.saveSession();
      ctx.print("Session saved.");
    },
  },
  {
    name: "resume",
    description: "Resume a saved session:  /resume [id]",
    run: (args, ctx) => {
      if (args[0]) ctx.resume(args[0]);
      else ctx.openSessionPicker();
    },
  },
  {
    name: "chats",
    description: "Browse, switch, or delete saved chats for this folder",
    run: (_args, ctx) => ctx.openSessionPicker(),
  },
  {
    name: "sessions",
    description: "Alias of /chats",
    run: (_args, ctx) => ctx.openSessionPicker(),
  },
  {
    name: "new",
    description: "Start a new chat (saves the current one first)",
    run: (_args, ctx) => { ctx.clearHistory(); ctx.print("Started a new chat. The previous one is saved — /chats to switch back."); },
  },
  {
    name: "add",
    description: "Add files/folders to context — picker, or /add <path>",
    run: (args, ctx) => {
      if (args.length) ctx.addPaths([args.join(" ")]);
      else ctx.openFiles();
    },
  },
  {
    name: "context",
    description: "Show the loaded project context file",
    run: (_args, ctx) => {
      const cfg = getConfig();
      const found = findProjectContext(cfg.cwd);
      if (found) {
        const lines = found.content.split("\n").length;
        ctx.print(`Project context loaded from ${found.file} (${lines} lines).`);
      } else {
        ctx.print("No project context file found (looked for LOCALCLI.md, AGENTS.md, CLAUDE.md). Run /init to create one.");
      }
    },
  },
  {
    name: "init",
    description: "Explore the project and generate LOCALCLI.md",
    run: (_args, ctx) => ctx.runInit(),
  },
  {
    name: "config",
    description: "Show or set config:  /config <key> <value>",
    run: (args, ctx) => {
      const cfg = getConfig();
      if (args.length === 0) {
        ctx.print(
          [
            "Config:",
            `  baseUrl:       ${cfg.baseUrl}`,
            `  provider:      ${cfg.provider}  (auto | ollama | vllm | openai)`,
            `  model:         ${cfg.model}`,
            `  maxTokens:     ${cfg.maxTokens}`,
            `  temperature:   ${cfg.temperature}`,
            `  contextWindow: ${cfg.contextWindow}  ${cfg.contextWindowPinned ? "(pinned by you — /config contextWindow auto to follow the model's native max again)" : "(always the selected model's full native max)"}`,
            `  autoCompact:   ${cfg.autoCompact}`,
            `  loopGuard:     ${cfg.loopGuard}  (auto-stop runaway repeat loops; off by default)`,
            `  stallHeartbeatSec: ${cfg.stallHeartbeatSec}  ("still loading" heartbeat while waiting for the first token; 0 = off)`,
            `  stallTimeoutSec:   ${cfg.stallTimeoutSec}  (abort+retry if no first token within this many seconds; 0 = off)`,
            `  alwaysAllow:   ${(cfg.alwaysAllow ?? []).join(", ") || "(none)"}  (tools that never prompt; manage with /allow)`,
            `  cwd:           ${cfg.cwd}`,
            "",
            "Set with: /config <key> <value>",
          ].join("\n")
        );
        return;
      }
      const [key, ...rest] = args;
      if (!key) return;
      const value = rest.join(" ");
      const numeric = ["maxTokens", "temperature", "contextWindow", "debugMaxIterations", "maxIterations", "stallHeartbeatSec", "stallTimeoutSec", "numGpu", "numThread"];
      const bool = ["autoCompact", "loopGuard", "thinking"];
      // "/config contextWindow auto" unpins: the window follows each model's
      // native limit again (a numeric value pins it — see below).
      if (key === "contextWindow" && value.toLowerCase() === "auto") {
        saveConfig({ contextWindowPinned: false });
        ctx.print("Context window unpinned — it will follow the selected model's full native max again (applies on the next model switch or restart).");
        return;
      }
      const updates: any = {};
      updates[key] = numeric.includes(key) ? Number(value)
        : bool.includes(key) ? value === "true"
        : value;
      if (numeric.includes(key) && Number.isNaN(updates[key])) {
        ctx.print(`"${value}" is not a number — ${key} needs a numeric value.`, "error");
        return;
      }
      // A hand-set context window is a deliberate choice (usually trading context
      // for speed): pin it so the per-model auto-sync stops silently pushing it
      // back to the model's native max on every restart. Unpin with
      // /config contextWindow auto.
      if (key === "contextWindow") updates.contextWindowPinned = true;
      // A new baseUrl means a possibly different backend — a stale pinned
      // provider (e.g. "vllm" left over while pointing back at Ollama) silently
      // routes requests the wrong way, so reset detection to auto. Pin again
      // with /backend or /config provider if needed.
      if (key === "baseUrl") updates.provider = "auto";
      saveConfig(updates);
      // baseUrl/apiKey rebuild the client; provider changes which backend we talk
      // to, so its detection cache must be dropped too (resetClient does both).
      if (key === "baseUrl" || key === "apiKey" || key === "provider") resetClient();
      ctx.print(`Set ${key} = ${value}${key === "baseUrl" ? "   (provider reset to auto — /backend to pin)" : ""}`);
    },
  },
  {
    name: "cwd",
    description: "Show or change the working directory:  /cwd <path>",
    run: (args, ctx) => {
      const cfg = getConfig();
      if (args.length === 0) {
        ctx.print(`Working directory: ${cfg.cwd}`);
        return;
      }
      const { resolve } = require("path");
      const { existsSync, statSync } = require("fs");
      const target = resolve(cfg.cwd, args.join(" "));
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        ctx.print(`Not a directory: ${target}`, "error");
        return;
      }
      saveConfig({ cwd: target });
      ctx.print(`Working directory set to ${target}\nTip: /init to generate context, or just start chatting.`);
    },
  },
  {
    name: "tokens",
    description: "Estimate tokens in the current conversation",
    run: (_args, ctx) => {
      const cfg = getConfig();
      // Same estimator the status bar / auto-compact use (handles attached
      // images correctly) — so /tokens never disagrees with the UI.
      const est = estimateTokens(ctx.history);
      const pct = Math.round((est / cfg.contextWindow) * 100);
      ctx.print(`~${est.toLocaleString()} tokens (${pct}% of ${cfg.contextWindow.toLocaleString()} window) across ${ctx.history.length} messages`);
    },
  },
  {
    name: "clear",
    description: "Clear the conversation history",
    run: (_args, ctx) => {
      ctx.clearHistory();
      ctx.print("Conversation cleared.");
    },
  },
  {
    name: "undo",
    description: "Revert the agent's file changes:  /undo · /undo 3 · /undo list",
    run: (args, ctx) => {
      if (args[0] === "list") { ctx.print(describeHistory()); return; }
      const n = args[0] ? Number(args[0]) : 1;
      if (!Number.isInteger(n) || n < 1) { ctx.print("Usage: /undo [count] — e.g. /undo or /undo 3. /undo list shows the history.", "error"); return; }
      ctx.print(undoLast(n));
    },
  },
  {
    name: "tasks",
    description: "Project task list:  /tasks · add <text> · done <n|text> · clean · clear",
    run: (args, ctx) => {
      const sub = args[0]?.toLowerCase();
      if (!sub) { ctx.print(describeTasks()); return; }
      if (sub === "add") {
        const text = args.slice(1).join(" ").trim();
        if (!text) { ctx.print("Usage: /tasks add <text>", "error"); return; }
        addTask(text);
        ctx.print(describeTasks());
        return;
      }
      if (sub === "done") {
        const ref = args.slice(1).join(" ").trim();
        if (!ref) { ctx.print("Usage: /tasks done <number | part of the text>", "error"); return; }
        const r = completeTask(ref);
        ctx.print(r.ok ? `Marked done: "${r.task!.text}".\n\n${describeTasks()}` : `No task matched "${ref}".`, r.ok ? undefined : "error");
        return;
      }
      if (sub === "clean") { const n = removeDoneTasks(); ctx.print(`Removed ${n} completed task${n === 1 ? "" : "s"}.\n\n${describeTasks()}`); return; }
      if (sub === "clear") { clearTasks(); ctx.print("Task list cleared."); return; }
      ctx.print("Usage: /tasks · /tasks add <text> · /tasks done <n|text> · /tasks clean · /tasks clear", "error");
    },
  },
  {
    name: "task",
    description: "Alias of /tasks",
    run: (args, ctx) => commandMap.get("tasks")!.run(args, ctx),
  },
  {
    name: "memory",
    description: "Project memory:  /memory · add <fact> · forget <text> · clear",
    run: (args, ctx) => {
      const sub = args[0]?.toLowerCase();
      if (!sub) {
        const mem = readMemory();
        ctx.print(mem
          ? `Project memory (.local-cli/memory.md — injected into every prompt):\n\n${mem}`
          : "Project memory is empty. The agent saves durable facts here with the remember tool; you can too: /memory add <fact>.");
        return;
      }
      if (sub === "add") {
        const fact = args.slice(1).join(" ").trim();
        if (!fact) { ctx.print("Usage: /memory add <fact>", "error"); return; }
        const { added } = addMemory(fact);
        ctx.print(added ? "Saved to project memory." : "That's already in memory.");
        return;
      }
      if (sub === "forget") {
        const match = args.slice(1).join(" ").trim();
        if (!match) { ctx.print("Usage: /memory forget <text to match>", "error"); return; }
        const n = forgetMemory(match);
        ctx.print(n ? `Forgot ${n} memory line${n === 1 ? "" : "s"} matching "${match}".` : `Nothing in memory matches "${match}".`);
        return;
      }
      if (sub === "clear") { ctx.print(clearMemory() ? "Project memory cleared." : "Memory was already empty."); return; }
      ctx.print("Usage: /memory · /memory add <fact> · /memory forget <text> · /memory clear", "error");
    },
  },
  {
    name: "index",
    description: "(Re)build the workspace code index used by /search and search_code",
    run: async (_args, ctx) => {
      ctx.print("Indexing workspace… (symbols + chunks; embeddings if an embedding model is installed)");
      try {
        const idx = await ensureIndex({ rebuild: true });
        ctx.print(describeIndex(idx));
      } catch (e: any) {
        ctx.print(`Indexing failed: ${e.message}`, "error");
      }
    },
  },
  {
    name: "search",
    description: "Semantic code search:  /search where are JWT tokens generated",
    run: async (args, ctx) => {
      const query = args.join(" ").trim();
      if (!query) { ctx.print("Usage: /search <what you're looking for, in plain words>", "error"); return; }
      try {
        const r = await searchCode(query);
        ctx.print(formatSearchResults(query, r));
      } catch (e: any) {
        ctx.print(`Search failed: ${e.message}`, "error");
      }
    },
  },
  {
    name: "agents",
    description: "Run parallel sub-agents:  /agents investigate X | review Y | test Z",
    run: async (args, ctx) => {
      const tasks = args.join(" ").split("|").map(t => t.trim()).filter(Boolean);
      if (tasks.length === 0) {
        ctx.print(
          "Usage: /agents <task 1> | <task 2> | …  (max 4; each gets a fresh context and reports back)\n" +
          "Prefix a task with a role to specialize it:\n" +
          "  explore: / review: / plan:  — read-only investigation\n" +
          "  test:                       — may run builds & tests\n" +
          "  code: / fix:                — may modify files\n" +
          "e.g. /agents test: run the suite | review: audit src/api error handling\n" +
          "Unprefixed tasks are read-only investigators; the main agent can implement from their reports.",
          "error");
        return;
      }
      ctx.print(`Spawning ${tasks.length} sub-agent${tasks.length === 1 ? "" : "s"}…\n${tasks.map((t, i) => `  ${String.fromCharCode(65 + i)}: ${t}`).join("\n")}\n(They share the local model, so they run queued — this can take a while.)`);
      try {
        const results = await runSubAgents(tasks);
        ctx.print(formatAgentResults(results));
        // Hand the reports to the MAIN conversation so the user can say "ok, do it".
        ctx.history.push({ role: "user", content: `[sub-agent reports — for your context]\n${formatAgentResults(results)}` });
      } catch (e: any) {
        ctx.print(`Sub-agents failed: ${e.message}`, "error");
      }
    },
  },
  {
    name: "review",
    description: "Review the working tree's pending changes (git diff) for bugs & quality",
    run: (_args, ctx) => {
      ctx.runAgent(
        "/review — reviewing pending changes",
        "Review the pending changes in this repository like a senior engineer:\n" +
        "1. Run `git status --short` and `git diff` (and `git diff --staged`) with bash. If the diff is empty, review the latest commit instead (`git show --stat HEAD` then `git show HEAD`).\n" +
        "2. For each changed file, read enough surrounding code (read_file) to judge the change in context.\n" +
        "3. Report: (a) bugs or logic errors, (b) security issues, (c) regressions/breaking changes, (d) code-quality improvements — each with file:line and a concrete suggestion. Order by severity.\n" +
        "4. Do NOT modify anything — this is a read-only review. End with a short verdict: safe to commit, or fix X first."
      );
    },
  },
  {
    name: "commit",
    description: "Stage & commit the pending changes with a generated message",
    run: (args, ctx) => {
      const hint = args.join(" ").trim();
      ctx.runAgent(
        "/commit — committing pending changes",
        "Create a git commit for the current working-tree changes:\n" +
        "1. Run `git status --short` and `git diff` (plus `git diff --staged`) with bash. If there is nothing to commit, say so and stop.\n" +
        "2. Read the changes and write ONE concise conventional-commit message (feat:/fix:/refactor:/docs:/chore: …) whose subject says WHAT and whose body (if needed) says WHY. Do not invent changes you didn't see in the diff.\n" +
        (hint ? `   The user's hint about this commit: "${hint}" — reflect it in the message.\n` : "") +
        "3. Stage the relevant files (`git add <paths>` — prefer explicit paths over `git add -A` when unrelated junk is present) and commit.\n" +
        "4. Show the result with `git log -1 --stat`.\n" +
        "Never push, never amend, and never commit files that look like secrets (.env, keys) — mention them instead."
      );
    },
  },
  {
    name: "test",
    description: "Run the project's tests and fix what fails:  /test [pattern]",
    run: (args, ctx) => {
      const scope = args.join(" ").trim();
      ctx.runAgent(
        `/test — running the test suite${scope ? ` (${scope})` : ""}`,
        "Run this project's tests and get them green:\n" +
        "1. Find the test command (package.json scripts, or the stack's convention — pytest, cargo test, go test…). Don't ask the user; detect it.\n" +
        (scope ? `2. The user wants to focus on: "${scope}" — run that subset if the runner supports it, otherwise the full suite.\n` : "2. Run the full suite with bash.\n") +
        "3. If there are failures: use set_todos to list them, then for each one read the failing test AND the code under test, decide which is wrong, fix the CODE (or the test only when the test itself is clearly outdated), and re-run.\n" +
        "4. Repeat fix → re-run until everything passes or you're genuinely stuck; then report what passed, what you fixed, and anything still failing with the real output quoted."
      );
    },
  },
  {
    name: "fix",
    description: "Evidence-driven bug fix:  /fix <what's broken>",
    run: (args, ctx) => {
      const desc = args.join(" ").trim();
      if (!desc) { ctx.print("Usage: /fix <describe the bug — e.g. /fix login returns 500 after signup>", "error"); return; }
      ctx.runAgent(
        `/fix — ${desc}`,
        `Fix this bug: "${desc}".\n` +
        "Work evidence-first, not from guesses:\n" +
        "1. REPRODUCE or locate the failure — run the relevant command/test/server and capture the actual error (bash / run_server / server_logs / browser_console).\n" +
        "2. Trace the root cause in the code (grep_files / read_file / search_code) and state it in one sentence, backed by the evidence.\n" +
        "3. Make the smallest correct fix with edit_file.\n" +
        "4. RE-RUN the same reproduction to prove it's fixed. Never declare it fixed without re-checking.\n" +
        "Use set_todos to track the steps if the fix spans several files."
      );
    },
  },
  {
    name: "explain",
    description: "Explain code or a concept in this repo:  /explain <file|symbol|question>",
    run: (args, ctx) => {
      const target = args.join(" ").trim();
      if (!target) { ctx.print("Usage: /explain <file, function, or question — e.g. /explain src/llm.ts or /explain how does auth work here>", "error"); return; }
      ctx.runAgent(
        `/explain — ${target}`,
        `Explain the following to the user: "${target}".\n` +
        "Read the actual code first (glob_files / grep_files / read_file / search_code) — never explain from memory alone. Do NOT modify anything.\n" +
        "Then explain clearly: what it does, how the pieces connect (with file:line references), why it's built that way if discernible, and any gotchas. Match the depth to the question — an architecture question gets a walkthrough, a one-liner gets a paragraph."
      );
    },
  },
  {
    name: "security",
    description: "Security review of the pending changes (read-only)",
    run: (_args, ctx) => {
      ctx.runAgent(
        "/security — security review of pending changes",
        "Do a SECURITY review of the pending changes in this repository (read-only — modify nothing):\n" +
        "1. `git status --short` and `git diff` (+ `--staged`); if empty, review the latest commit (`git show HEAD`).\n" +
        "2. For each changed file, read enough context to judge it, then check specifically for: injection (SQL/command/path traversal), XSS and unsafe HTML, authn/authz gaps, secrets or keys committed in code, insecure defaults (CORS *, debug on, weak crypto/random), unvalidated input at trust boundaries, and dependency risks.\n" +
        "3. Report each finding with file:line, severity (critical/high/medium/low), a concrete exploit scenario, and the fix. If nothing is wrong, say so plainly.\n" +
        "End with a verdict: safe to ship, or fix X first."
      );
    },
  },
  {
    name: "debug",
    description: "Toggle debug mode (evidence-driven fix & verify loop)",
    run: (_args, ctx) => {
      const next: Mode = ctx.mode === "debug" ? "normal" : "debug";
      ctx.setMode(next);
      ctx.print(next === "debug"
        ? "Debug mode ON — I'll reproduce, gather live evidence (logs/console/network), fix, and re-verify. Describe the bug."
        : "Debug mode OFF — back to normal mode.");
    },
  },
  {
    name: "todos",
    description: "Show the live session checklist:  /todos · /todos clear",
    run: (args, ctx) => {
      if (args[0]?.toLowerCase() === "clear") {
        const had = getSessionTodos().length;
        clearSessionTodos();
        ctx.print(had ? "Session todos cleared." : "Session todos were already empty.");
        return;
      }
      ctx.print(formatSessionTodos() + "\n\n(This is the agent's live checklist for the current task — /tasks is the persistent cross-session list.)");
    },
  },
  {
    name: "ps",
    description: "Show models resident in Ollama: VRAM residency + unload timer",
    run: async (_args, ctx) => {
      const cfg = getConfig();
      if (!(await isOllama(cfg.baseUrl))) {
        ctx.print(`/ps needs Ollama — the endpoint ${cfg.baseUrl} doesn't look like Ollama.`, "error");
        return;
      }
      const models = await loadedModels(cfg.baseUrl);
      ctx.print(formatLoadedModels(models, cfg.model));
    },
  },
  {
    name: "benchmark",
    description: "Measure the current model's real speed (load, prefill, tokens/sec)",
    run: async (_args, ctx) => {
      const cfg = getConfig();
      ctx.print(`Benchmarking ${cfg.model}…`);
      const PROMPT = "Write a 150-word explanation of how a hash map works internally.";
      const provider = await detectProvider(cfg.baseUrl, cfg.provider);
      try {
        if (provider === "ollama") {
          const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
          const t0 = Date.now();
          const res = await fetch(`${host}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: cfg.model,
              prompt: PROMPT,
              stream: false,
              options: { num_predict: 256, temperature: 0.3, num_ctx: cfg.contextWindow },
              keep_alive: cfg.keepAlive ?? "30m",
            }),
          });
          if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
          const data: any = await res.json();
          const wall = (Date.now() - t0) / 1000;
          const ns = 1e9;
          const loadS = (data.load_duration ?? 0) / ns;
          const prefillTok = data.prompt_eval_count ?? 0;
          const prefillS = (data.prompt_eval_duration ?? 0) / ns;
          const genTok = data.eval_count ?? 0;
          const genS = (data.eval_duration ?? 0) / ns;
          ctx.print([
            `Benchmark — ${cfg.model}  (ollama)`,
            `  Model load:   ${loadS < 0.05 ? "already resident" : loadS.toFixed(1) + "s"}`,
            `  Prefill:      ${prefillTok} tokens in ${prefillS.toFixed(2)}s${prefillS > 0 ? ` (${(prefillTok / prefillS).toFixed(0)} tok/s)` : ""}`,
            `  Generation:   ${genTok} tokens in ${genS.toFixed(2)}s${genS > 0 ? ` (${(genTok / genS).toFixed(1)} tok/s)` : ""}`,
            `  Wall clock:   ${wall.toFixed(1)}s end to end`,
            "",
            genS > 0 && genTok / genS < 10 ? "⚠ Under 10 tok/s usually means the model doesn't fit in VRAM — check /system." : "Speed looks healthy for local inference.",
          ].join("\n"));
          return;
        }
        // vLLM / any OpenAI-compatible server: stream and measure time-to-first-
        // token (a prefill-latency proxy) and generation tokens/sec. Token counts
        // come from the usage chunk (stream_options) with a chunk-count fallback.
        const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const t0 = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: "user", content: PROMPT }],
            stream: true,
            max_tokens: 256,
            temperature: 0.3,
            stream_options: { include_usage: true },
          }),
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("response has no stream body");
        const dec = new TextDecoder();
        let buf = "", tFirst = 0, chunks = 0, promptTok = 0, genTok = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            const payload = s.slice(5).trim();
            if (payload === "[DONE]") continue;
            let j: any;
            try { j = JSON.parse(payload); } catch { continue; }
            if (j.choices?.[0]?.delta?.content) { if (!tFirst) tFirst = Date.now(); chunks++; }
            if (j.usage) { promptTok = j.usage.prompt_tokens ?? promptTok; genTok = j.usage.completion_tokens ?? genTok; }
          }
        }
        const tEnd = Date.now();
        const ttft = ((tFirst || tEnd) - t0) / 1000;
        const genS = (tEnd - (tFirst || tEnd)) / 1000;
        const outTok = genTok || chunks;
        const tps = genS > 0 ? outTok / genS : 0;
        ctx.print([
          `Benchmark — ${cfg.model}  (${provider})`,
          `  Time to first token: ${ttft.toFixed(2)}s${promptTok ? `  (prefilled ~${promptTok} prompt tokens)` : ""}`,
          `  Generation:          ${outTok} tokens in ${genS.toFixed(2)}s${tps ? ` (${tps.toFixed(1)} tok/s)` : ""}`,
          `  Wall clock:          ${((tEnd - t0) / 1000).toFixed(1)}s end to end`,
          "",
          tps && tps < 10 ? "⚠ Under 10 tok/s — the model may be spilling out of VRAM (lower context / use a smaller quant)." : "Speed looks healthy.",
        ].join("\n"));
      } catch (e: any) {
        ctx.print(`Benchmark failed: ${e.message}`, "error");
      }
    },
  },
  {
    name: "export",
    description: "Export this conversation to markdown:  /export [file]",
    run: (args, ctx) => {
      const { writeFileSync } = require("fs");
      const { resolve } = require("path");
      const cfg = getConfig();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const file = args[0] || `chat-export-${stamp}.md`;
      const fp = resolve(cfg.cwd, file);
      const lines: string[] = [`# local-cli session — ${new Date().toLocaleString()}`, `Model: ${cfg.model}`, ""];
      for (const m of ctx.history) {
        if (m.role === "system") continue;
        if (m.role === "user") {
          const text = typeof m.content === "string" ? m.content : "";
          if (text.startsWith("[automatic notice") || text.startsWith("<tool_response")) continue;
          lines.push(`## ❯ User\n\n${text}\n`);
        } else if (m.role === "assistant") {
          const text = typeof m.content === "string" ? m.content : "";
          if (text.trim()) lines.push(`## ◆ Assistant\n\n${text}\n`);
          for (const tc of (m as any).tool_calls ?? []) {
            lines.push(`> 🛠 ${tc.function.name}(${(tc.function.arguments ?? "").slice(0, 200)})`);
          }
        } else if (m.role === "tool") {
          const text = typeof m.content === "string" ? m.content : "";
          lines.push("```\n" + text.slice(0, 800) + (text.length > 800 ? "\n… (truncated)" : "") + "\n```\n");
        }
      }
      try {
        writeFileSync(fp, lines.join("\n"), "utf-8");
        ctx.print(`Exported ${ctx.history.length} messages to ${file}`);
      } catch (e: any) {
        ctx.print(`Export failed: ${e.message}`, "error");
      }
    },
  },
  {
    name: "theme",
    description: "Switch the color theme:  /theme mocha|tokyo|dark|light|mono",
    run: (args, ctx) => {
      const names = themeNames();
      const name = args[0]?.toLowerCase();
      if (!name) {
        ctx.print(`Current theme: ${getConfig().theme}\nAvailable: ${names.join(", ")}\nSwitch with /theme <name>.`);
        return;
      }
      if (!applyTheme(name)) { ctx.print(`Unknown theme "${name}". Available: ${names.join(", ")}`, "error"); return; }
      saveConfig({ theme: name });
      ctx.print(`Theme set to ${name}. (Colors apply to everything rendered from now on.)`);
    },
  },
  {
    name: "icons",
    description: "Switch the glyph set:  /icons auto|unicode|ascii  (ascii fixes \"?\" on legacy consoles)",
    run: (args, ctx) => {
      const choice = args[0]?.toLowerCase();
      if (!choice) {
        ctx.print(`Current icon style: ${getConfig().iconStyle} (auto-detected: ${detectIconStyle()}).\n` +
          `Options: auto, unicode, ascii.\n` +
          `Use /icons ascii if symbols show as "?" in this terminal, /icons unicode for the rich set.`);
        return;
      }
      if (choice !== "auto" && choice !== "unicode" && choice !== "ascii") {
        ctx.print(`Unknown icon style "${choice}". Options: auto, unicode, ascii.`, "error");
        return;
      }
      const resolved = applyIconStyle(choice);
      saveConfig({ iconStyle: choice });
      ctx.print(`Icon style set to ${choice}${choice === "auto" ? ` (using ${resolved})` : ""}. Applies to everything rendered from now on.`);
    },
  },
  {
    name: "sandbox",
    description: "Run bash commands in a container:  /sandbox docker|podman|off",
    run: (args, ctx) => {
      const cfg = getConfig();
      const sub = args[0]?.toLowerCase();
      if (!sub || sub === "status") {
        ctx.print(cfg.sandbox === "none"
          ? "Sandbox OFF — bash commands run directly on this machine.\nEnable with /sandbox docker (or podman). Image: /sandbox image <name>."
          : `Sandbox ON — bash commands run inside ${cfg.sandbox} (image: ${cfg.sandboxImage}, project mounted at /work).\nDisable with /sandbox off.`);
        return;
      }
      if (sub === "off" || sub === "none") { saveConfig({ sandbox: "none" }); ctx.print("Sandbox disabled — bash runs on the host again."); return; }
      if (sub === "docker" || sub === "podman") {
        saveConfig({ sandbox: sub });
        ctx.print(`Sandbox enabled: bash commands now run inside ${sub} (image: ${getConfig().sandboxImage}, project mounted at /work).\nNote: dev servers (run_server) still run on the host so their ports stay reachable.`);
        return;
      }
      if (sub === "image" && args[1]) { saveConfig({ sandboxImage: args[1] }); ctx.print(`Sandbox image set to ${args[1]}.`); return; }
      ctx.print("Usage: /sandbox docker|podman|off|status · /sandbox image <name>", "error");
    },
  },
  {
    name: "exit",
    description: "Quit the CLI",
    run: (_args, ctx) => ctx.exit(),
  },
];

const commandMap = new Map(commands.map(c => [c.name, c]));
commandMap.set("quit", commandMap.get("exit")!);

export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

export async function runCommand(input: string, ctx: CommandContext): Promise<void> {
  const parts = input.trim().slice(1).split(/\s+/);
  const name = parts[0] ?? "";
  const args = parts.slice(1);
  const cmd = commandMap.get(name);
  if (!cmd) {
    ctx.print(`Unknown command: /${name} — type /help`, "error");
    return;
  }
  await cmd.run(args, ctx);
}

export function commandNames(): string[] {
  return commands.map(c => c.name);
}

// Name + description for every command, for the slash-command menu in the input.
export function commandList(): { name: string; description: string }[] {
  return commands.map(c => ({ name: c.name, description: c.description }));
}
