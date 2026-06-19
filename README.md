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

## Recommended models per task

Different jobs want different models. Run **`/system`** (CLI) or open the
**System** panel (web) for a hardware check + picks tuned to your RAM/VRAM.

| Task | Good local models |
|---|---|
| **Coding** | `qwen2.5-coder` (3B/7B/14B/32B — pick by VRAM) — the most reliable local coder |
| **Vision** (`browser_screenshot`, `screenshot`) | `qwen2.5vl`, `llava`, `llama3.2-vision`, `moondream` |
| **General / reasoning / tools** | `qwen3`, `gemma3` |

Rough VRAM (Q4): 3B ≈ 3 GB · 7B ≈ 6 GB · 14B ≈ 10 GB · 32B ≈ 20 GB. No GPU? It
runs on CPU+RAM, just slower. The `system_info` tool / `/system` command evaluates
your CPU, RAM, and GPU/VRAM and tells you what fits.

## Autonomy

Three modes (persist across restarts): **normal** asks before each mutating action,
**plan** researches first, **auto** runs everything by itself. Set **auto** once
(shift+tab in the CLI, or the mode toggle in the web header) and the agent works
unattended — no per-action approvals.

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

### Modes — `shift+tab` cycles `normal → plan → auto-accept → debug`

- **normal** — mutating tools ask for permission, with a **diff preview** of
  exactly what `edit_file` / `write_file` will change.
- **plan** — the agent can only use read-only tools to research, then presents a
  numbered plan; `write_file` / `edit_file` / `delete_file` / `bash` are blocked.
  When the plan is ready: `a` approve & build, `k` keep refining, `esc` cancel.
- **auto-accept** — mutating tools run without prompting. The status bar shows an
  `AUTO` badge so you always know it's on.
- **debug** — select it, then describe the bug or what to verify. The agent runs
  an evidence-driven loop: reproduce → gather live signals (`server_logs`,
  `browser_console`, `browser_network`, `browser_performance`) → diagnose → fix →
  re-verify, looping until it's resolved (still asks permission per change, like
  normal). A `DEBUG` badge shows it's on. The same selector exists in the web UI.

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
| `/learn [name]` | Analyze this project to learn your coding style → saved as a named profile used everywhere |
| `/profiles` | Pick which saved profile is active (web, desktop, mobile…) |
| `/profile [name]` | Show a coding profile (defaults to the active one) |
| `/delprofile <name>` | Delete a saved coding profile |
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
| `/undo [n\|list]` | Revert the agent's last file change(s) — every mutation is snapshotted |
| `/tasks [add\|done\|clean\|clear]` | Persistent project task list (`.local-cli/tasks.md`) |
| `/memory [add\|forget\|clear]` | Persistent per-project agent memory (`.local-cli/memory.md`) |
| `/index` | (Re)build the workspace code index (symbols, endpoints, chunks) |
| `/search <query>` | Semantic code search — by meaning, not exact strings |
| `/agents <t1> \| <t2>` | Spawn up to 4 read-only sub-agents that investigate in parallel and report back |
| `/review` | Review the pending `git diff` like a senior engineer (read-only) |
| `/benchmark` | Measure the current model's real load/prefill/generation speed |
| `/export [file]` | Export the conversation to a markdown file |
| `/theme [name]` | Switch the color theme: `mocha` (default), `tokyo`, `dark`, `light`, `mono` |
| `/icons auto\|unicode\|ascii` | Glyph set — `ascii` fixes icons showing as `?` on the legacy Windows console (auto-detected) |
| `/sandbox docker\|podman\|off` | Run `bash` commands inside a throwaway container |
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

**Asking you:** `ask_user` lets the agent pop an interactive picker when a choice
is genuinely yours to make — which package manager (when several are installed),
framework, language, overwrite vs merge — instead of guessing or making you set it
manually. It only asks when it can't infer the answer itself.

**Browser & vision** (test what it builds, and *see*):
`browser_open` drives a real Chrome/Edge (via the DevTools Protocol — no extra
install) to open a web app; `browser_read` reads the page text + console errors;
`browser_click` interacts; `browser_screenshot` captures the page and a
vision-capable model **describes/debugs the rendered UI**. `screenshot` captures
your desktop for analysis when you ask it to look at what you're doing. Vision
tools need a vision-capable model (e.g. gemma3/4 vision, llava, qwen2.5-vl).

**Ports:** `list_ports` / `kill_port` free a stuck port so a dev server can bind.

**Memory:** `read_profile` / `update_profile` let the agent recall and persist
your cross-project coding conventions on its own (see *Coding profiles* below).
`remember` / `recall` do the same for facts about the *current project*
(architecture decisions, gotchas, "never touch X") in `.local-cli/memory.md`,
injected into every future session here. `task_add` / `task_done` / `task_list`
maintain a persistent project checklist (`.local-cli/tasks.md`) so multi-session
work survives restarts.

**Semantic search:** `search_code` finds code by *meaning* ("where are JWT
tokens generated") over a workspace index of symbols, endpoints, and chunks
(`index_workspace` / `/index` rebuilds it). If an Ollama embedding model is
installed (`ollama pull nomic-embed-text`) it uses real embeddings; otherwise it
falls back to smart keyword scoring.

**Sub-agents:** `spawn_agents` delegates 1–4 focused investigation/review tasks
to headless sub-agents, each with a fresh context, that report back. Read-only
unless explicitly granted write access.

**Browser DevTools:** after `browser_open`, `browser_console` reads the JS
console, `browser_network` lists requests with statuses (failures first), and
`browser_performance` reports TTFB/FCP/LCP, heap, and DOM size — debugging
without screenshots.

**Safety nets:** every `write_file` / `edit_file` / `delete_file` is snapshotted
to `.local-cli/history/` — `/undo` rolls back (great with auto mode). When a
background server prints an error (`TypeError`, `Build failed`, `EADDRINUSE`…),
it's injected into the agent's context automatically — no need to ask for logs.
`edit_file` resolves near-miss matches itself: exact → whitespace-tolerant →
similarity-based fuzzy matching. In the permission prompt, press `s` to apply
only *some* hunks of a proposed diff. `/sandbox docker` runs `bash` commands in
a disposable container with the project mounted at `/work`.

Mutating tools (`write_file`, `edit_file`, `delete_file`, `bash`, `run_server`,
`stop_server`, `update_profile`) prompt for permission — answer `y`, `N`, or `a`
(always allow that tool for the session). Auto-accept mode runs them without
prompting.

## Coding profiles — teach it your style once, everywhere

Run `/learn <name>` inside a project that represents how you like to code (e.g.
`/learn web`). The agent explores the **whole** project — structure, stack, and
representative files from every top-level area, not just `src/` — then writes a
**coding profile** to `~/.local-cli/profiles/<name>.md` describing your stack,
directory/file naming, conventions, and practices. The active profile is injected
into every prompt afterward, in **every** project, so the agent codes the way you
do — even when scaffolding from an empty folder.

**Multiple named profiles.** Keep separate profiles for different kinds of work —
`web`, `desktop`, `mobile` — and switch the active one with **`/profiles`** (an
arrow-key picker). `/profile [name]` shows one; `/delprofile <name>` removes it.
This is what makes the CLI reusable by anyone for anything, not just one stack.

**The agent keeps its own memory.** It has `read_profile` and `update_profile`
tools, so when you tell it a durable convention mid-conversation ("the API lives
in `/api` outside `src`", "we always use kebab-case files"), it **saves that to
the active profile itself** — no command needed — so the rule persists into future
projects instead of being lost when you switch folders. Project-specific facts go
to that project's `LOCALCLI.md` instead.

**Package manager.** The agent uses the one installed on your machine: it detects
the project's lockfile *and* checks which managers actually exist on your system,
so it never tries to run (or install) one you don't have — e.g. it uses `bun`
instead of a missing `npm`. When several are installed and the project doesn't
specify one, it **asks you with a picker** (via `ask_user`) rather than guessing.
Lock a default any time with `/pm`.

## Configuration

Settings persist to `~/.local-cli/config.json`. Defaults target Ollama at
`http://localhost:11434/v1`. Reasoning output from Qwen3 (`<think>…</think>`) is
detected and dimmed automatically.

Notable keys (`/config <key> <value>`):

| Key | Default | Meaning |
|---|---|---|
| `toolMode` | `auto` | `auto` detects native tool support per model; force with `native` / `prompted` |
| `contextWindow` | per-model | Auto-set to the selected model's native context length; used for the status bar count and auto-compaction. Override with `/config contextWindow N` |
| `autoCompact` | `true` | Auto-summarize the conversation past 80% of the window |
| `temperature` | `0.6` | Sampling temperature |

## Interface

A full terminal UI built with [Ink](https://github.com/vadimdemedes/ink) (React
for the terminal): a gradient header showing model + endpoint + cwd, streaming
responses with markdown and dimmed `<think>` reasoning, per-tool cards with
result previews, an interactive permission prompt, arrow-key pickers (models,
sessions), a plan-approval prompt, and a status bar showing mode, model, and
context usage as a count against the model's limit (`18,400 / 32,768 (56%)`).
While the model streams, a single live line shows tokens generated, elapsed time,
and real-time tok/s; `esc` interrupts. The context window auto-adjusts to each
model's native limit when you switch models.

## Project layout

```
index.ts              entry point, arg parsing, one-shot mode, Ink render
src/
  config.ts           persisted settings (~/.local-cli/config.json)
  profile.ts          named coding profiles + package-manager detection
  proc.ts             background server/process registry (run_server et al.)
  ports.ts            list/free TCP ports (list_ports / kill_port)
  browser.ts          browser control via the Chrome DevTools Protocol
  vision.ts           screen capture + image analysis through a vision model
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

280 tests across tool execution, the splitter, native + **prompted** tool-calling
(XML raw-body format, full-file write verbatim, the `400` fallback), the diff,
sessions/compaction/context, named coding profiles + agent-driven profile updates
+ package-manager detection, background servers (real processes, log capture, URL
detection), the custom input (history + paste), the slash-command menu, and the
TUI flows:

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
