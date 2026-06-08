import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getConfig, saveConfig } from "../config";
import { resetClient } from "../llm";
import { findProjectContext } from "../context";
import { listOllamaModelsDetailed, modelInfo, modelHint, formatCtx } from "../ollama";
import {
  readProfileByName, listProfileNames, getActiveProfileName, setActiveProfile,
  deleteProfileByName, detectPackageManager, resolvePackageManager,
} from "../profile";
import { listServersTool, stopServerTool, listPortsTool, killPortTool, systemInfoTool } from "../tools/executor";
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
}

export interface SlashCommand {
  name: string;
  description: string;
  run: (args: string[], ctx: CommandContext) => void | Promise<void>;
}

const commands: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run: (_args, ctx) => {
      const lines = ["Commands:"];
      for (const c of commands) lines.push(`  /${c.name.padEnd(10)} ${c.description}`);
      lines.push("");
      lines.push("shift+tab toggles plan mode · @file attaches a file · esc interrupts a response");
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
    name: "model",
    description: "Pick a model, or set one:  /model <name>",
    run: (args, ctx) => {
      if (args.length === 0) { ctx.openModelPicker(); return; }
      saveConfig({ model: args[0] });
      resetClient();
      ctx.print(`Model set to ${args[0]}`);
    },
  },
  {
    name: "models",
    description: "List installed Ollama models with size & params",
    run: async (_args, ctx) => {
      const cfg = getConfig();
      try {
        const live = await listOllamaModelsDetailed(cfg.baseUrl);
        if (live.length) {
          const width = Math.max(...live.map(m => m.name.length));
          ctx.print(
            "Installed models (ollama list):\n" +
            live.map(m => {
              const hint = modelHint(m);
              return `  ${m.name === cfg.model ? "●" : " "} ${m.name.padEnd(width)}${hint ? "   " + hint : ""}`;
            }).join("\n") +
            "\n\nTip: /modelinfo [name] for context length & capabilities."
          );
          return;
        }
        ctx.print("Ollama reported no models. Pull one with: ollama pull <name>");
      } catch {
        ctx.print("Couldn't reach Ollama. Configured fallback:\n" + cfg.models.map(m => `  ${m === cfg.model ? "● " : "  "}${m}`).join("\n"), "error");
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
            `  model:         ${cfg.model}`,
            `  maxTokens:     ${cfg.maxTokens}`,
            `  temperature:   ${cfg.temperature}`,
            `  contextWindow: ${cfg.contextWindow}`,
            `  autoCompact:   ${cfg.autoCompact}`,
            `  loopGuard:     ${cfg.loopGuard}  (auto-stop runaway repeat loops; off by default)`,
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
      const numeric = ["maxTokens", "temperature", "contextWindow"];
      const bool = ["autoCompact", "loopGuard"];
      const updates: any = {};
      updates[key] = numeric.includes(key) ? Number(value)
        : bool.includes(key) ? value === "true"
        : value;
      saveConfig(updates);
      if (key === "baseUrl" || key === "apiKey") resetClient();
      ctx.print(`Set ${key} = ${value}`);
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
      const chars = JSON.stringify(ctx.history).length;
      const cfg = getConfig();
      const est = Math.round(chars / 4);
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
