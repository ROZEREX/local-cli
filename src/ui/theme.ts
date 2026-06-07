// Tokyo Night — without purple (swapped for blues/cyans/teals/greens).
// Truecolor; degrades gracefully on 256/16-color terminals.
export const theme = {
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
  // Syntax-highlighting palette (no purple).
  syntax: {
    keyword: "#7aa2f7",   // blue
    func: "#7dcfff",      // cyan
    type: "#2ac3de",      // bright cyan
    string: "#9ece6a",    // green
    number: "#ff9e64",    // orange
    comment: "#565f89",   // gray
    constant: "#ff9e64",  // orange (true/false/null)
    operator: "#89ddff",  // light blue
    property: "#73daca",  // teal (object keys)
    tag: "#f7768e",       // red (html tags)
    attr: "#e0af68",      // yellow (html attrs)
    plain: "#c0caf5",
  },
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
  gradient: ["#7dcfff", "#7aa2f7", "#73daca"],
} as const;

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
};

// Accent color per tool, for the card's left border.
export const toolColor: Record<string, string> = {
  read_file: theme.color.accent,
  write_file: theme.color.success,
  edit_file: theme.color.primary,
  glob_files: theme.color.accent,
  grep_files: theme.color.accent,
  list_dir: theme.color.accent,
  bash: theme.color.warn,
  delete_file: theme.color.error,
  run_server: theme.color.success,
  server_logs: theme.color.accent,
  stop_server: theme.color.error,
  list_servers: theme.color.accent,
  read_profile: theme.color.primary,
  update_profile: theme.color.primary,
};
