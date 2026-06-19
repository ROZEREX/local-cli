import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getConfig, saveConfig } from "../config";
import { resetClient } from "../llm";
import { findProjectContext } from "../context";
import { listOllamaModelsWithContext, modelInfo, modelHint, formatCtx, agentFitnessWarning, loadedModels, isOllama, formatLoadedModels } from "../ollama";
import {
  readProfileByName, listProfileNames, getActiveProfileName, setActiveProfile,
  deleteProfileByName, detectPackageManager, resolvePackageManager,
} from "../profile";
import { listServersTool, stopServerTool, listPortsTool, killPortTool, systemInfoTool } from "../tools/executor";
import { undoLast, describeHistory } from "../history";
import { readMemory, addMemory, forgetMemory, clearMemory } from "../memory";
import { describeTasks, addTask, completeTask, removeDoneTasks, clearTasks } from "../tasks";
import { ensureIndex, searchCode, formatSearchResults } from "../search";
import { describeIndex } from "../indexer";
import { runSubAgents, formatAgentResults } from "../agents";
import { applyTheme, themeNames } from "../ui/theme";
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
      // Warn up front if this model can't act as an agent (best-effort, async).
      void agentFitnessWarning(getConfig().baseUrl, args[0]!)
        .then(w => { if (w) ctx.print(w); })
        .catch(() => {});
    },
  },
  {
    name: "models",
    description: "List installed Ollama models with size & params",
    run: async (_args, ctx) => {
      const cfg = getConfig();
      try {
        const live = await listOllamaModelsWithContext(cfg.baseUrl);
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
            `  model:         ${cfg.model}`,
            `  maxTokens:     ${cfg.maxTokens}`,
            `  temperature:   ${cfg.temperature}`,
            `  contextWindow: ${cfg.contextWindow}  (auto-set to the model's native limit on each model switch)`,
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
      const numeric = ["maxTokens", "temperature", "contextWindow", "debugMaxIterations", "stallHeartbeatSec", "stallTimeoutSec"];
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
        ctx.print("Usage: /agents <task 1> | <task 2> | …  (max 4; each gets a fresh context and reports back)\nSub-agents are read-only — they investigate and report. The main agent can then implement.", "error");
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
      try {
        const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
        const t0 = Date.now();
        const res = await fetch(`${host}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cfg.model,
            prompt: "Write a 150-word explanation of how a hash map works internally.",
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
          `Benchmark — ${cfg.model}`,
          `  Model load:   ${loadS < 0.05 ? "already resident" : loadS.toFixed(1) + "s"}`,
          `  Prefill:      ${prefillTok} tokens in ${prefillS.toFixed(2)}s${prefillS > 0 ? ` (${(prefillTok / prefillS).toFixed(0)} tok/s)` : ""}`,
          `  Generation:   ${genTok} tokens in ${genS.toFixed(2)}s${genS > 0 ? ` (${(genTok / genS).toFixed(1)} tok/s)` : ""}`,
          `  Wall clock:   ${wall.toFixed(1)}s end to end`,
          "",
          genS > 0 && genTok / genS < 10 ? "⚠ Under 10 tok/s usually means the model doesn't fit in VRAM — check /system." : "Speed looks healthy for local inference.",
        ].join("\n"));
      } catch (e: any) {
        ctx.print(`Benchmark failed: ${e.message} (the /api/generate benchmark needs Ollama).`, "error");
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
    description: "Switch the color theme:  /theme tokyo|dark|light|mono",
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
