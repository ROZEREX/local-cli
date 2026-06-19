#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import chalk from "chalk";
import { getConfig, saveConfig } from "./src/config";
import { applyTheme } from "./src/ui/theme";
import { App } from "./src/ui/App";
import { chat } from "./src/llm";
import { systemPrompt } from "./src/prompt";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

function parseArgs(argv: string[]) {
  const opts: { model?: string; baseUrl?: string; prompt?: string; help?: boolean; resume?: boolean } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--model" || a === "-m") opts.model = argv[++i];
    else if (a === "--base-url" || a === "-b") opts.baseUrl = argv[++i];
    else if (a === "--prompt" || a === "-p") opts.prompt = argv[++i];
    else if (a === "--continue" || a === "-c" || a === "--resume") opts.resume = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else rest.push(a);
  }
  if (!opts.prompt && rest.length > 0) {
    if (rest.length === 1 && rest[0] === "start") {
      // Ignore bare 'start' command, letting it start the interactive TUI
    } else {
      opts.prompt = rest.join(" ");
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
${chalk.bold("local-cli")} — a local coding agent for Ollama / OpenAI-compatible LLMs

${chalk.bold("Usage:")}
  local-cli                      Start interactive TUI
  local-cli -c                   Resume the most recent session for this folder
  local-cli -p "task"            Run a single task and exit
  local-cli -m qwen3:latest      Start with a specific model

${chalk.bold("Options:")}
  -m, --model <name>       Model to use
  -b, --base-url <url>     OpenAI-compatible base URL (default: Ollama)
  -p, --prompt <text>      One-shot prompt (non-interactive)
  -c, --continue           Resume the most recent session for this folder
  -h, --help               Show this help

${chalk.bold("In the TUI:")} shift+tab = plan mode · /model = pick model · /resume = sessions
                /compact = shrink context · /init = generate project context

${chalk.bold("Config file:")} ~/.local-cli/config.json
`);
}

async function oneShot(prompt: string) {
  const history: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: prompt },
  ];
  await chat(history, {
    onText: (c) => process.stdout.write(c),
    onToolCall: (name, args) => {
      let summary = args;
      try { summary = JSON.stringify(JSON.parse(args)); } catch {}
      process.stdout.write(chalk.blue(`\n◆ ${name} `) + chalk.dim(summary) + "\n");
    },
    onToolResult: (_name, result) => {
      const lines = result.split("\n").slice(0, 4);
      process.stdout.write(chalk.dim(lines.map(l => "  │ " + l).join("\n")) + "\n");
    },
    onError: (err) => process.stdout.write(chalk.red(`\n[error] ${err.message}\n`)),
    onNotice: (msg) => process.stdout.write(chalk.dim(`\n[${msg}]\n`)),
    // One-shot mode auto-approves; it's non-interactive by design.
    requestPermission: async () => true,
  });
  process.stdout.write("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  if (opts.model) saveConfig({ model: opts.model });
  if (opts.baseUrl) saveConfig({ baseUrl: opts.baseUrl });
  // Always anchor cwd to where the user launched the CLI.
  saveConfig({ cwd: process.cwd() });
  applyTheme(getConfig().theme);

  if (opts.prompt) {
    await oneShot(opts.prompt);
    return;
  }

  // Interactive TUI. exitOnCtrlC handles quit; patchConsole keeps stray
  // logs from corrupting the Ink render.
  const { waitUntilExit } = render(React.createElement(App, { autoResume: opts.resume }), {
    exitOnCtrlC: true,
    patchConsole: true,
  });
  await waitUntilExit();
}

main().catch((e) => {
  console.error(chalk.red("Fatal:"), e);
  process.exit(1);
});
