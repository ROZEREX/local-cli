# local-cli

A local coding agent for the terminal — like Claude Code, but pointed at your own
LLMs via Ollama or any OpenAI-compatible endpoint. Built for **Qwen 3 / 3.5** and
**DeepSeek-Coder-V2**, which other tools support poorly.

It can read, write, edit, search, and run code on your machine through a tool-use
loop, with a permission gate on anything that touches disk or runs a command.

### Works with models that lack native tool calling

Many local models (e.g. `deepseek-coder-v2-lite`) have no function-calling
support — Ollama returns `400 does not support tools`. local-cli **detects this
automatically** (via Ollama's capabilities, or by catching the 400) and falls
back to **prompted tool-calling**, with a one-line notice telling you it did.

Crucially, the prompted format uses **XML tags with raw, unescaped bodies** —
`<write_file path="…">…full file…</write_file>` — *not* JSON string arguments.
Code models choke on escaping a whole file into a JSON string and will bail to
printing a markdown block instead; raw bodies fix that, so the model reliably
**creates the actual files** (complete, untruncated) rather than telling you to
save them yourself.

## Setup

### Windows

**1. Install Bun**

Open PowerShell and run:
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```
Restart your terminal after. Verify with `bun --version`.

**2. Install Ollama**

Download and run the installer from **https://ollama.com/download/windows**.
After install, Ollama runs as a background service automatically.

**3. Clone and install**

Use **Windows Terminal** (recommended — best color support) or PowerShell:
```powershell
git clone https://github.com/ROZEREX/local-cli.git
cd local-cli
bun install
```

**4. Pull a model and run**

```powershell
ollama pull qwen2.5-coder    # recommended for coding tasks
ollama pull qwen3            # great for reasoning
bun run start
```

---

### Linux

**1. Install Bun**

```bash
curl -fsSL https://bun.sh/install | bash
```
Restart your terminal (or `source ~/.bashrc`). Verify with `bun --version`.

**2. Install Ollama**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```
This installs Ollama as a systemd service — it starts automatically on boot.
To start it manually: `ollama serve`.

**3. Install clipboard support** *(optional — for Ctrl+V paste)*

```bash
# Ubuntu / Debian — X11
sudo apt install xclip

# Arch
sudo pacman -S xclip

# Wayland (GNOME, KDE) — usually pre-installed
sudo apt install wl-clipboard
```
Everything works without this — only Ctrl+V clipboard paste needs it.

**4. Clone and install**

```bash
git clone https://github.com/ROZEREX/local-cli.git
cd local-cli
bun install
```

**5. Pull a model and run**

```bash
ollama pull qwen2.5-coder    # recommended for coding tasks
ollama pull qwen3            # great for reasoning
bun run start
```

Best experienced in a truecolor terminal: GNOME Terminal, Alacritty, Kitty,
or any terminal with `COLORTERM=truecolor`.

---

### macOS

**1. Install Bun**

```bash
curl -fsSL https://bun.sh/install | bash
```

**2. Install Ollama**

Download from **https://ollama.com/download/mac** and drag to Applications,
or via Homebrew: `brew install ollama`.

**3. Clone and install**

```bash
git clone https://github.com/ROZEREX/local-cli.git
cd local-cli
bun install
```

**4. Pull a model and run**

```bash
ollama pull qwen2.5-coder
bun run start
```

## Usage

```bash
# interactive REPL
bun run start

# one-shot, non-interactive (auto-approves tools)
bun run index.ts -p "add a health-check route to server.ts"

# pick a model / endpoint
bun run index.ts -m qwen2.5-coder:latest
bun run index.ts -b http://localhost:1234/v1   # e.g. LM Studio
```

### In the TUI

- Type a message to chat. The agent uses tools to explore and edit your code.
- `/` — opens a **command menu** that filters as you type; `↑`/`↓` to move,
  `tab` to complete, `enter` to run, `esc` to close.
- `@path/to/file` — pull a file's contents into context for your message.
- `↑` / `↓` — recall previous inputs (shell-style history).
- `Ctrl+V` — paste from the system clipboard (works even when the terminal eats
  Ctrl+V in raw mode). `Ctrl+U` clears the line.
- `shift+tab` — cycle the mode (see below).
- `esc` — interrupt a running response. `Ctrl+C` — quit.

### Modes — `shift+tab` cycles `normal → plan → auto-accept`

- **normal** — mutating tools ask for permission, with a **diff preview** of
  exactly what `edit_file` / `write_file` will change.
- **plan** — the agent can only use read-only tools to research, then presents a
  numbered plan; `write_file` / `edit_file` / `delete_file` / `bash` are blocked.
  When the plan is ready: `a` approve & build, `k` keep refining, `esc` cancel.
- **auto-accept** — mutating tools run without prompting. The status bar shows an
  `AUTO` badge so you always know it's on.

### Sessions & context

- Conversations **auto-save** per folder after every turn. Resume with `/resume`
  (arrow-key picker) or launch with `local-cli -c` to continue the latest.
- `/init` explores the project and writes a `LOCALCLI.md`. On startup that file
  (or `AGENTS.md` / `CLAUDE.md`) is auto-loaded into context so the agent always
  knows the project.
- `/compact` summarizes the conversation to reclaim tokens; this also happens
  **automatically** when usage passes 80% of the context window (`autoCompact`).

### Slash commands

| Command | Description |
|---|---|
| `/help` | List commands |
| `/plan` | Toggle plan mode |
| `/model [name]` | Pick a model (arrow-key picker), or set one by name |
| `/models` | List installed Ollama models with size, parameters & quantization |
| `/modelinfo [name]` | Full details for one model — native context length, capabilities |
| `/learn [path]` | Analyze a project to learn your coding style → saved as a profile used everywhere |
| `/profile` | Show the learned coding profile |
| `/pm [auto\|bun\|npm\|pnpm\|yarn]` | Show or set the package manager |
| `/servers [stop <id>]` | List background servers, or stop one |
| `/resume [id]` | Resume a saved session (picker if no id) |
| `/sessions` | List & pick a saved session for this folder |
| `/save` | Save the current session now |
| `/compact` | Summarize & shrink the conversation to save tokens |
| `/context` | Show the loaded project context file |
| `/init` | Explore the project and generate `LOCALCLI.md` |
| `/config [key value]` | Show or set config (model, contextWindow, autoCompact, …) |
| `/cwd [path]` | Show or change the working directory |
| `/tokens` | Show token usage vs. the context window |
| `/clear` | Clear the conversation |
| `/exit` | Quit |

## Tools the agent can use

**Files & shell:** `read_file`, `write_file`, `edit_file`, `glob_files`,
`grep_files`, `list_dir`, `bash`, `delete_file`.

**Running & hosting** (so it can run what it builds and fix it):
`run_server` starts a long-lived process (dev server, watcher, host) in the
background and returns its URL/port; `server_logs` reads its output so the agent
can spot runtime errors and fix them; `stop_server` / `list_servers` manage them.
Unlike `bash` (which runs to completion), servers keep running while you keep
chatting, and are killed automatically when you quit.

Mutating tools (`write_file`, `edit_file`, `delete_file`, `bash`, `run_server`,
`stop_server`) prompt for permission — answer `y`, `N`, or `a` (always allow that
tool for the session). Auto-accept mode runs them without prompting.

## Learning your style — `/learn`

Run `/learn` inside a project that represents how you like to code. The agent
reads the structure, stack, and several source files, then writes a **coding
profile** to `~/.local-cli/profile.md` describing your stack, directory/file
naming, conventions, and practices. That profile is injected into every prompt
afterward — in **every** project — so the agent codes the way you do. View it
with `/profile`, re-run `/learn` anytime to update it.

The agent also detects your **package manager** from the lockfile (bun, npm,
pnpm, yarn) and uses it; if there's no lockfile it asks which you want. Override
with `/pm`.

## Configuration

Settings persist to `~/.local-cli/config.json`. Defaults target Ollama at
`http://localhost:11434/v1`. Reasoning output from Qwen3 (`<think>…</think>`) is
detected and dimmed automatically.

Notable keys (`/config <key> <value>`):

| Key | Default | Meaning |
|---|---|---|
| `toolMode` | `auto` | `auto` detects native tool support per model; force with `native` / `prompted` |
| `contextWindow` | `32768` | Token budget used for the status bar % and auto-compaction |
| `autoCompact` | `true` | Auto-summarize the conversation past 80% of the window |
| `temperature` | `0.6` | Sampling temperature |

## Interface

A full terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React
for the terminal): a gradient header showing model + endpoint + cwd, streaming
responses with markdown and dimmed `<think>` reasoning, per-tool cards with
result previews, an interactive permission prompt, arrow-key pickers (models,
sessions), a plan-approval prompt, and a live status bar showing mode, model,
cwd, and context usage (`~18,400 (56%)`). `esc` interrupts an in-flight response.

## Project layout

```
index.ts              entry point, arg parsing, one-shot mode, Ink render
src/
  config.ts           persisted settings (~/.local-cli/config.json)
  profile.ts          learned coding profile + package-manager detection
  proc.ts             background server/process registry (run_server et al.)
  prompt.ts           dynamic system prompt (mode, profile, context, tool docs)
  llm.ts              streaming loop: native + prompted tool-calling, compaction
  ollama.ts           list installed models, detect native tool support
  toolparse.ts        parse tool calls from content (tags / fences / bare JSON)
  think.ts            TagSplitter (+ <think> reasoning splitter)
  diff.ts             LCS line diff for the edit/write preview
  clipboard.ts        system clipboard read for Ctrl+V paste
  context.ts          finds & loads the project context file (LOCALCLI.md, …)
  session.ts          per-folder session save / resume
  tools/              tool schemas + file/bash implementations
  commands/           slash commands
  ui/
    App.tsx           top-level TUI: chat loop, modes, sessions, overlays
    components.tsx    banner, tool cards, status bar, pickers, input, diff
    markdown.tsx      lightweight terminal markdown renderer
    theme.ts          colors + glyphs
```

## Tests

236 tests across tool execution, the splitter, native + **prompted** tool-calling
(XML raw-body format, full-file write verbatim, the `400` fallback), the diff,
sessions/compaction/context, the coding profile + package-manager detection,
background servers (real processes, log capture, URL detection), the custom input
(history + paste), the slash-command menu, and the TUI flows:

```bash
bun run test         # full suite (uses mock servers, no model needed)
bun run test:live    # live check against the real Ollama model
```

## Publishing to GitHub (first time)

### 1 — Create the repo on GitHub

Go to **https://github.com/new** and create an empty repository (no README, no
`.gitignore`, no license — we already have all of those). Name it whatever you
like (e.g. `local-cli`). Set it to **Public**. Copy the URL it shows you
(something like `https://github.com/ROZEREX/local-cli.git`).

### 2 — First-time Git setup (one-off, if you've never used Git on this machine)

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

### 3 — Initialize, commit, and push

Run these commands inside the `local-cli` folder:

```bash
# Turn the folder into a Git repository
git init

# Stage everything (the .gitignore already excludes node_modules, .claude/settings.local.json, etc.)
git add .

# Create the first commit
git commit -m "Initial commit — local-cli v0.1.0"

# Point it at your GitHub repo (replace the URL with yours)
git remote add origin https://github.com/ROZEREX/local-cli.git

# Push to GitHub
git push -u origin main
```

If Git says the branch is called `master` instead of `main`:

```bash
git branch -M main
git push -u origin main
```

### 4 — Future updates

```bash
git add .
git commit -m "describe what you changed"
git push
```

### What is NOT committed (safe by default)

| Path | Why excluded |
|---|---|
| `node_modules/` | Installed by `bun install`, not source |
| `.claude/settings.local.json` | Machine-specific tool permissions with local paths |
| `.env` / `.env.*` | Environment variables (none used here, but blocked as a precaution) |
| `~/.local-cli/` | Runtime data — sessions, config — lives in your home directory, entirely outside this repo |

> **Note:** The config file at `~/.local-cli/config.json` (your model, working
> directory, API key) lives in your **home folder**, not this repo. It is never
> committed. Everyone who clones the repo starts with the built-in defaults and
> sets their own config on first run.
