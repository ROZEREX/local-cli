// Theme presets, selectable with /theme. Default: "mocha" — a modern
// Catppuccin-inspired palette (deep slate, soft blue/teal, warm peach accent;
// no purple, per preference). Truecolor; degrades gracefully on 256/16-color
// terminals. The `theme` object is MUTATED in place by applyTheme so every
// component picks up the new palette on its next render.

interface Palette {
  color: {
    primary: string; accent: string; success: string; warn: string; error: string;
    dim: string; fg: string; user: string; tool: string; think: string;
    // Faint foreground for secondary/metadata text — brighter than `dim`, used
    // for tree-connector result previews so they read as content, not chrome.
    muted: string;
  };
  syntax: {
    keyword: string; func: string; type: string; string: string; number: string;
    comment: string; constant: string; operator: string; property: string;
    tag: string; attr: string; plain: string;
  };
  gradient: string[];
}

// ── Default: Catppuccin Mocha, de-purpled ────────────────────────────────────
const mocha: Palette = {
  color: {
    primary: "#89b4fa",   // blue — assistant / brand
    accent: "#fab387",    // peach — warm secondary accent (MiMo-ish warmth)
    success: "#a6e3a1",   // green
    warn: "#f9e2af",      // yellow
    error: "#f38ba8",     // red/pink
    dim: "#6c7086",       // overlay0 — chrome / separators
    fg: "#cdd6f4",        // text
    user: "#89dceb",      // sky — the human
    tool: "#94e2d5",      // teal — tool calls
    think: "#585b70",     // surface2 — reasoning
    muted: "#a6adc8",     // subtext0 — secondary content
  },
  syntax: {
    keyword: "#f38ba8", func: "#89b4fa", type: "#f9e2af", string: "#a6e3a1",
    number: "#fab387", comment: "#6c7086", constant: "#fab387", operator: "#94e2d5",
    property: "#89dceb", tag: "#f38ba8", attr: "#f9e2af", plain: "#cdd6f4",
  },
  gradient: ["#89dceb", "#89b4fa", "#94e2d5"],
};

const tokyo: Palette = {
  color: {
    primary: "#7aa2f7",   // blue — assistant / brand
    accent: "#73daca",    // teal — secondary accent (replaces purple)
    success: "#9ece6a",   // green
    warn: "#e0af68",      // amber
    error: "#f7768e",     // red/pink
    dim: "#565f89",       // muted slate
    fg: "#c0caf5",        // default foreground
    user: "#7dcfff",      // cyan — the human
    tool: "#7dcfff",      // cyan — tool calls
    think: "#565f89",     // muted — reasoning
    muted: "#9aa5ce",     // brighter slate — secondary content
  },
  syntax: {
    keyword: "#7aa2f7", func: "#7dcfff", type: "#2ac3de", string: "#9ece6a",
    number: "#ff9e64", comment: "#565f89", constant: "#ff9e64", operator: "#89ddff",
    property: "#73daca", tag: "#f7768e", attr: "#e0af68", plain: "#c0caf5",
  },
  gradient: ["#7dcfff", "#7aa2f7", "#73daca"],
};

const dark: Palette = {
  color: {
    primary: "#61afef", accent: "#56b6c2", success: "#98c379", warn: "#e5c07b",
    error: "#e06c75", dim: "#5c6370", fg: "#abb2bf", user: "#56b6c2",
    tool: "#56b6c2", think: "#5c6370", muted: "#828a99",
  },
  syntax: {
    keyword: "#61afef", func: "#56b6c2", type: "#e5c07b", string: "#98c379",
    number: "#d19a66", comment: "#5c6370", constant: "#d19a66", operator: "#abb2bf",
    property: "#56b6c2", tag: "#e06c75", attr: "#e5c07b", plain: "#abb2bf",
  },
  gradient: ["#56b6c2", "#61afef", "#98c379"],
};

const light: Palette = {
  color: {
    primary: "#0550ae", accent: "#0969da", success: "#1a7f37", warn: "#9a6700",
    error: "#cf222e", dim: "#6e7781", fg: "#1f2328", user: "#0969da",
    tool: "#0969da", think: "#6e7781", muted: "#57606a",
  },
  syntax: {
    keyword: "#cf222e", func: "#8250df", type: "#953800", string: "#0a3069",
    number: "#0550ae", comment: "#6e7781", constant: "#0550ae", operator: "#1f2328",
    property: "#0969da", tag: "#116329", attr: "#0550ae", plain: "#1f2328",
  },
  gradient: ["#0969da", "#0550ae", "#1a7f37"],
};

const mono: Palette = {
  color: {
    primary: "#ffffff", accent: "#bbbbbb", success: "#dddddd", warn: "#999999",
    error: "#ffffff", dim: "#666666", fg: "#cccccc", user: "#ffffff",
    tool: "#bbbbbb", think: "#666666", muted: "#999999",
  },
  syntax: {
    keyword: "#ffffff", func: "#dddddd", type: "#bbbbbb", string: "#aaaaaa",
    number: "#cccccc", comment: "#666666", constant: "#cccccc", operator: "#999999",
    property: "#bbbbbb", tag: "#dddddd", attr: "#aaaaaa", plain: "#cccccc",
  },
  gradient: ["#ffffff", "#bbbbbb", "#888888"],
};

export const THEME_PRESETS: Record<string, Palette> = { mocha, tokyo, dark, light, mono };
export function themeNames(): string[] { return Object.keys(THEME_PRESETS); }

// ── Icon sets ────────────────────────────────────────────────────────────────
// Two glyph sets so the UI renders cleanly everywhere. `unicode` is the rich
// default for modern terminals (Windows Terminal, VS Code, iTerm, most *nix).
// `ascii` is a fallback for the legacy Windows console (conhost / powershell.exe,
// cmd.exe) whose default font can't draw dingbats/technical symbols and shows
// them as "?" — it sticks to ASCII + CP437 + box-drawing chars that console
// proves it can render. Switch with /icons; auto-detected by default.
export type IconSet = typeof ICON_UNICODE;

const ICON_UNICODE = {
  user: "❯",
  assistant: "⏺",   // filled bullet — heads each assistant / tool turn
  tool: "⏺",
  branch: "⎿",      // tree connector under a tool call → its result
  thinking: "✻",
  run: "▸",
  ok: "✓",
  fail: "✗",
  warn: "▲",
  bullet: "•",
  folder: "▪",
  model: "◇",
  tokens: "◷",
  server: "⌁",
  arrowR: "→",
  spark: "✦",
  dot: "●",
  gem: "◆",
  barFull: "▰",
  barEmpty: "▱",
  cursor: "▍",
  quote: "▏",
  ellipsis: "…",
  radioOn: "◉",
  radioOff: "○",
};

const ICON_ASCII: IconSet = {
  user: ">",
  assistant: "*",
  tool: "*",
  branch: "└",      // box-drawing — renders even on legacy conhost
  thinking: "*",
  run: ">",
  ok: "√",          // CP437 — renders on conhost
  fail: "x",
  warn: "▲",        // CP437 geometric shape — renders on conhost
  bullet: "*",
  folder: "■",      // CP437 — renders on conhost
  model: "■",
  tokens: "·",
  server: "·",
  arrowR: "→",      // CP437 arrow — renders on conhost
  spark: "*",
  dot: "*",
  gem: "*",
  barFull: "█",     // CP437 block — renders on conhost
  barEmpty: "░",    // CP437 shade — renders on conhost
  cursor: "_",
  quote: "│",       // box-drawing — renders on conhost
  ellipsis: "...",
  radioOn: "[x]",
  radioOff: "[ ]",
};

const ICON_SETS: Record<string, IconSet> = { unicode: ICON_UNICODE, ascii: ICON_ASCII };

// Best-effort guess at whether the terminal can draw the rich glyph set. Modern
// terminals (and anything non-Windows) get unicode; the legacy Windows console
// gets the ascii fallback.
export function detectIconStyle(): "unicode" | "ascii" {
  if (process.platform !== "win32") return "unicode";
  const env = process.env;
  if (env.WT_SESSION) return "unicode";              // Windows Terminal
  if (env.TERM_PROGRAM === "vscode") return "unicode"; // VS Code integrated terminal
  if (env.ConEmuPID || env.ConEmuANSI === "ON") return "unicode"; // ConEmu / Cmder
  if (env.WSL_DISTRO_NAME || env.WSLENV) return "unicode";        // WSL
  if (env.TERM && env.TERM !== "dumb") return "unicode";          // an xterm-ish TERM is set
  return "ascii"; // bare powershell.exe / cmd.exe → conhost
}

export const theme = {
  color: { ...mocha.color },
  syntax: { ...mocha.syntax },
  icon: { ...ICON_UNICODE },
  // Gradient stops used for the banner / accents.
  gradient: [...mocha.gradient] as string[],
};

// Switch the active glyph set in place (so every component picks it up on its
// next render). "auto" resolves via detectIconStyle(). Returns the resolved set.
export function applyIconStyle(style: "auto" | "unicode" | "ascii"): "unicode" | "ascii" {
  const resolved = style === "auto" ? detectIconStyle() : style;
  Object.assign(theme.icon, ICON_SETS[resolved] ?? ICON_UNICODE);
  return resolved;
}

// Which theme color each tool's card border uses (resolved on applyTheme).
type ThemeColorKey = keyof Palette["color"];
const toolColorKey: Record<string, ThemeColorKey> = {
  read_file: "accent",
  write_file: "success",
  edit_file: "primary",
  glob_files: "accent",
  grep_files: "accent",
  list_dir: "accent",
  bash: "warn",
  delete_file: "error",
  run_server: "success",
  server_logs: "accent",
  stop_server: "error",
  list_servers: "accent",
  read_profile: "primary",
  update_profile: "primary",
  ask_user: "warn",
  list_ports: "accent",
  kill_port: "error",
  browser_open: "primary",
  browser_read: "accent",
  browser_click: "primary",
  browser_type: "primary",
  browser_scroll: "accent",
  browser_screenshot: "accent",
  browser_close: "dim",
  browser_console: "accent",
  browser_network: "accent",
  browser_performance: "accent",
  screenshot: "accent",
  system_info: "accent",
  page_open: "primary",
  page_navigate: "primary",
  page_read: "accent",
  page_find: "accent",
  page_click: "primary",
  page_type: "primary",
  page_highlight: "warn",
  page_scroll: "accent",
  search_code: "accent",
  index_workspace: "accent",
  remember: "primary",
  recall: "primary",
  task_add: "success",
  task_done: "success",
  task_list: "accent",
  spawn_agents: "warn",
};

// Per-tool glyphs for the tool cards.
export const toolIcon: Record<string, string> = {
  read_file: "▤",
  write_file: "✎",
  edit_file: "✦",
  glob_files: "❉",
  grep_files: "⌕",
  list_dir: "▣",
  bash: "⌘",
  delete_file: "␡",
  run_server: "▶",
  server_logs: "≡",
  stop_server: "■",
  list_servers: "☰",
  read_profile: "◈",
  update_profile: "◈",
  ask_user: "?",
  list_ports: "⊞",
  kill_port: "⏻",
  browser_open: "◍",
  browser_read: "◉",
  browser_click: "☞",
  browser_type: "⌨",
  browser_scroll: "↕",
  browser_screenshot: "▦",
  browser_close: "◌",
  browser_console: "≣",
  browser_network: "⇅",
  browser_performance: "◔",
  screenshot: "▦",
  system_info: "▤",
  page_open: "◍",
  page_navigate: "➤",
  page_read: "◉",
  page_find: "⌕",
  page_click: "☞",
  page_type: "⌨",
  page_highlight: "✺",
  page_scroll: "↕",
  search_code: "❂",
  index_workspace: "⛃",
  remember: "✎",
  recall: "◈",
  task_add: "☐",
  task_done: "☑",
  task_list: "☰",
  spawn_agents: "⧉",
};

// Accent color per tool, for the card's left border (kept in sync by applyTheme).
export const toolColor: Record<string, string> = {};

function refreshToolColors(): void {
  for (const [tool, key] of Object.entries(toolColorKey)) toolColor[tool] = theme.color[key];
}

// Switch the active palette in place. Unknown names are ignored (returns false).
export function applyTheme(name: string): boolean {
  const preset = THEME_PRESETS[name];
  if (!preset) return false;
  Object.assign(theme.color, preset.color);
  Object.assign(theme.syntax, preset.syntax);
  theme.gradient.splice(0, theme.gradient.length, ...preset.gradient);
  refreshToolColors();
  return true;
}

refreshToolColors();
