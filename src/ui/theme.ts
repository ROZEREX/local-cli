// Theme presets, selectable with /theme. Default: Tokyo Night without purple
// (swapped for blues/cyans/teals/greens). Truecolor; degrades gracefully on
// 256/16-color terminals. The `theme` object is MUTATED in place by applyTheme
// so every component picks up the new palette on its next render.

interface Palette {
  color: {
    primary: string; accent: string; success: string; warn: string; error: string;
    dim: string; fg: string; user: string; tool: string; think: string;
  };
  syntax: {
    keyword: string; func: string; type: string; string: string; number: string;
    comment: string; constant: string; operator: string; property: string;
    tag: string; attr: string; plain: string;
  };
  gradient: string[];
}

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
    tool: "#56b6c2", think: "#5c6370",
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
    tool: "#0969da", think: "#6e7781",
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
    tool: "#bbbbbb", think: "#666666",
  },
  syntax: {
    keyword: "#ffffff", func: "#dddddd", type: "#bbbbbb", string: "#aaaaaa",
    number: "#cccccc", comment: "#666666", constant: "#cccccc", operator: "#999999",
    property: "#bbbbbb", tag: "#dddddd", attr: "#aaaaaa", plain: "#cccccc",
  },
  gradient: ["#ffffff", "#bbbbbb", "#888888"],
};

export const THEME_PRESETS: Record<string, Palette> = { tokyo, dark, light, mono };
export function themeNames(): string[] { return Object.keys(THEME_PRESETS); }

export const theme = {
  color: { ...tokyo.color },
  syntax: { ...tokyo.syntax },
  icon: {
    user: "❯",
    assistant: "◆",
    tool: "⛁",
    thinking: "✶",
    run: "▸",
    ok: "✔",
    fail: "✘",
    warn: "⚠",
    bullet: "•",
    folder: "▣",
    model: "◇",
    tokens: "∑",
    arrowR: "→",
    spark: "✦",
    dot: "●",
  },
  // Gradient stops used for the banner / accents.
  gradient: [...tokyo.gradient] as string[],
};

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
