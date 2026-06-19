# local-cli Feature & Option Audit (Wholecheck)

This document provides a comprehensive audit of all features, slash commands, tools, configuration options, and backend mechanisms within the `local-cli` project, along with detailed recommendations for enhancements and new additions.

---

## 1. Interaction Modes

The agent supports three core modes of operation that control user permissions and safety barriers.

| Mode | Current Behavior | Implementation Context | Improvement Opportunities |
| :--- | :--- | :--- | :--- |
| **Normal** | Prompts for permission with a diff preview on mutating tools. | Default interactive loop, controlled via `App.tsx` and `llm.ts`. | • **Inline diff editing**: Allow editing/rejecting specific hunks before applying.<br>• **Undo history**: Maintain a session undo stack to roll back mutating operations. |
| **Plan** | Research-only mode. Blocks mutating tools and forces the agent to present a plan. | Injected in `systemPrompt()` (`prompt.ts`) and checked in `runTool()` (`llm.ts`). | • **Plan exporter**: Export plans directly to a `PLAN.md` file in the workspace.<br>• **Interactive checklists**: Allow the user to check off parts of the plan to guide execution. |
| **Auto-Accept** | Runs mutating tools autonomously without user prompting. | Indicated with an `AUTO` badge in the TUI status bar. | • **Safe command list**: Allow restricting which commands run autonomously (e.g. only file writes, never `bash` or `kill_port`). |

---

## 2. Slash Commands Audit

Slash commands provide shortcuts in the TUI input and the web interface.

| Command | Purpose | Evaluation / Current State | Recommended Improvements / Additions |
| :--- | :--- | :--- | :--- |
| `/help` | Lists all commands & shortcuts. | Static text array in `commands/index.ts`. | • Add searchable command descriptions.<br>• Group commands by category (e.g., Session, Model, Server). |
| `/plan` | Toggles Plan mode. | Toggle function. | • Allow `/plan <task>` to initiate a specific planning session. |
| `/model` | Switch model or open picker. | Updates config and resets LLM client. | • Support hot-reloading models during active generation. |
| `/models` | List installed Ollama models. | Contacts Ollama `/api/tags` to fetch models. | • Show disk/memory footprint of each model. |
| `/modelinfo` | Show details (context, capabilities). | Pulls detailed configuration of the model. | • Display estimated generation speed (Tokens/sec) based on history. |
| `/learn` | Learns coding style into profile. | Scrapes workspace files to build style guides. | • Add configuration options to ignore specific paths (e.g., `.gitignore` integration). |
| `/profiles` | Switch coding profile. | Lists and selects profile. | • Inject profile metrics (e.g. "applied 12 times in this project"). |
| `/profile` | Show current/named profile. | Displays markdown contents of profile. | • Add an interactive profile rule editor in the TUI. |
| `/delprofile` | Delete named profile. | Deletes markdown file. | • Add confirmation prompt to prevent accidental loss of profiles. |
| `/pm` | Set package manager. | Checks lockfile and user preference. | • Add auto-fallback chain (e.g. if bun fails, fall back to npm). |
| `/servers` | Manage background servers. | Lists and stops `run_server` processes. | • Add a server process monitor (CPU / Memory usage). |
| `/system` | Display hardware info. | Checks CPU, RAM, and GPU capabilities. | • Suggest model recommendations dynamically based on actual VRAM available. |
| `/browser` | Shows browser control guide. | Static documentation output. | • Include diagnostic tests to verify if DevTools Protocol ports are accessible. |
| `/ports` | Manage system TCP ports. | Lists and kills listening processes. | • Display process owners/usernames for safety. |
| `/allow` | Configure always-allow tools. | Saves list of allowed tools to config. | • Add wildcard support or target-specific permissions (e.g., `bash:npm run test`). |
| `/think` | Toggle thinking visibility. | Switches reasoning stream state. | • Support hiding `<think>` blocks retrospectively in logs. |
| `/compact` | Reclaims context space. | Summarizes history when context window >80%. | • Add visual indicators showing how many tokens were saved after compacting. |
| `/save` | Save session. | Saves to folder history. | • Add tag/label support to easily identify specific saved points. |
| `/resume` | Resume session. | Picks/loads folder session. | • Searchable session history based on topics or dates. |
| `/chats` | Alias of `/resume`. | Session picker. | • Merge under a single, unified picker experience. |
| `/new` | Start fresh chat. | Resets history and saves current. | • Support session templates (e.g. "Bugfix template", "Feature template"). |
| `/add` | Add files to context. | Injects file contents into prompt. | • Add search-by-symbol capability inside the file adder. |
| `/context` | Show project context. | Shows `LOCALCLI.md` location. | • Highlight stale sections in the loaded project context. |
| `/init` | Generate context file. | Explores codebase to produce `LOCALCLI.md`.| • Auto-update option when files change significantly. |
| `/config` | Read or write settings. | Interacts with `~/.local-cli/config.json`.| • Provide validation for key types and value bounds. |
| `/cwd` | Manage working directory. | Changes agent context folder. | • Support multi-cwd workspaces simultaneously. |
| `/tokens` | Show token stats. | Estimates usage metrics. | • Display historical token usage cost/rate. |
| `/clear` | Clear conversation history. | Clears messages. | • Retain system prompt structure on clear. |
| `/exit` | Exit the CLI. | Shuts down process cleanly. | • Ensure background servers are fully terminated before exiting. |

---

## 3. Agent Tools Audit

Tools allow the LLM to inspect, mutate, and execute code.

### A. Filesystem & Shell Tools
*   `read_file`, `write_file`, `edit_file`, `delete_file`, `glob_files`, `grep_files`, `list_dir`, `bash`
*   **Current State:** Solid base implementing standard file operations with relative/absolute path resolution. `edit_file` relies on exact string match.
*   **Improvement Opportunities:**
    *   **Fuzzy match editing:** `edit_file` should have a fuzzy/diff-fallback mode when whitespace/indents differ slightly from the target `old_string`.
    *   **Token-safe reads:** Warn the model (or automatically truncate) when attempting to read large binary/minified files.

### B. Background Server Tools
*   `run_server`, `server_logs`, `stop_server`, `list_servers`
*   **Current State:** Launches background processes and reads logs. Extremely helpful for dev-servers.
*   **Improvement Opportunities:**
    *   **Auto-Port Forwarding:** Suggest or automate exposing port to local network if requested.
    *   **Interactive Input:** Allow passing keyboard events or signals to the server stdout/stdin.

### C. Browser & Vision Tools
*   `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_close`, `screenshot`
*   **Current State:** Spawns a dedicated browser window for app testing. Vision capability enables visual verification of UI layouts.
*   **Improvement Opportunities:**
    *   **Headless option:** Allow running the browser in headless mode to save local screen real estate.
    *   **Console listener:** Automatically stream new Javascript errors as tool outputs during navigation.

### D. Chrome Extension (Live Browser) Tools
*   `page_open`, `page_navigate`, `page_read`, `page_find`, `page_click`, `page_type`, `page_highlight`, `page_scroll`
*   **Current State:** Allows driving the user's active browser tab via Chrome Extension.
*   **Improvement Opportunities:**
    *   **Cookie/Auth Sharing:** Clarify safety and handling of cookie states in profiles.
    *   **Multi-Tab management:** Allow switching and tracking active pages across multiple extension tabs.

### E. Memory & System Tools
*   `read_profile`, `update_profile`, `system_info`
*   **Current State:** Maintains user profiles (`~/.local-cli/profiles/`) and returns hardware stats.
*   **Improvement Opportunities:**
    *   **Remote Profiles:** Support downloading/syncing profiles from Git repositories.

---

## 4. Configuration Options (`Config` Interface)

Settings are persisted in `~/.local-cli/config.json`.

*   `baseUrl`: Ollama or OpenAI-compatible backend endpoint.
*   `apiKey`: API Key (defaults to `ollama`).
*   `model`: Active model name.
*   `models`: List of installed/configured models.
*   `maxTokens`: Output token cap.
*   `temperature`: Creativity controller (0.0 to 1.0).
*   `cwd`: Workspace working directory.
*   `contextWindow`: Context size in tokens.
*   `autoCompact`: Automatic context reduction toggle.
*   `thinking`: Reasoning visibility toggle.
*   `toolMode`: `"auto" | "native" | "prompted"`.
*   `packageManager`: Preferred lockfile utility (`"auto" | "bun" | "npm" | "pnpm" | "yarn"`).
*   `activeProfile`: Selected user coding profile.
*   `mode`: Active interaction mode (`"normal" | "plan" | "auto"`).
*   `alwaysAllow`: List of tools that never prompt.
*   `loopGuard`: Repeats protection toggle.
*   `keepAlive`: Ollama resident timeout override.
*   `numGpu` / `numThread`: VRAM/CPU tuning variables.

---

## 5. Summary of Recommended Enhancements

### 1. Robust File Editing
*   **Fuzzy Search Fallback:** Upgrade the `edit_file` implementation to utilize Levenshtein distance or block diff mapping when exact string matching fails due to line endings or minor indentation differences.

### 2. Sandbox for Command Execution
*   **Safety Sandboxing:** For command execution (`bash`), optionally integrate a containerized environment (e.g. Docker, or isolated subshells) when running in `auto-accept` mode to protect host machines from destructive commands.

### 3. High-Performance Token Optimization
*   **Token Pruning:** Prune redundant tool results from history during compaction, rather than performing simple text summaries, to keep critical code snippets in context longer.

### 4. Interactive TUI Enhancements
*   **Color Themes:** Support switching terminal themes (e.g. Gruvbox, Monokai, Nord) via slash commands.
*   **Autocomplete:** Integrate shell autocomplete for path names when executing `/add` or `/cwd`.
