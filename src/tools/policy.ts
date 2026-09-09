/**
 * Security policy for every model-callable tool.
 *
 * The important invariant is fail-closed: a tool that is added to the executor
 * but not classified here is treated as requiring approval and is never run in
 * parallel. This prevents a new side-effecting tool from silently inheriting a
 * read-only posture.
 */
export interface ToolPolicy {
  /** Whether a normal-mode call needs explicit user approval. */
  permission: "none" | "required";
  /** Whether calls of this tool are safe to execute concurrently. */
  parallel: boolean;
}

const READ_PARALLEL: ToolPolicy = Object.freeze({ permission: "none", parallel: true });
const READ_SEQUENTIAL: ToolPolicy = Object.freeze({ permission: "none", parallel: false });
const INTERACTIVE: ToolPolicy = Object.freeze({ permission: "none", parallel: false });
const MUTATING: ToolPolicy = Object.freeze({ permission: "required", parallel: false });

// Keep this list explicit and exhaustive. `toolPolicy()` deliberately falls
// back to MUTATING for unknown names, so omissions are safe rather than silent.
export const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  read_file: READ_PARALLEL,
  write_file: MUTATING,
  edit_file: MUTATING,
  glob_files: READ_PARALLEL,
  grep_files: READ_PARALLEL,
  list_dir: READ_PARALLEL,
  bash: MUTATING,
  delete_file: MUTATING,
  run_server: MUTATING,
  server_logs: READ_PARALLEL,
  stop_server: MUTATING,
  list_servers: READ_PARALLEL,
  ask_user: INTERACTIVE,
  list_ports: READ_PARALLEL,
  kill_port: MUTATING,
  browser_open: MUTATING,
  browser_read: READ_SEQUENTIAL,
  browser_click: MUTATING,
  browser_type: MUTATING,
  browser_scroll: MUTATING,
  browser_screenshot: READ_SEQUENTIAL,
  browser_close: MUTATING,
  screenshot: MUTATING,
  page_open: MUTATING,
  page_navigate: MUTATING,
  page_read: READ_SEQUENTIAL,
  page_find: MUTATING,
  page_click: MUTATING,
  page_type: MUTATING,
  page_highlight: MUTATING,
  page_scroll: MUTATING,
  system_info: READ_PARALLEL,
  read_profile: READ_PARALLEL,
  // search_code may refresh a derived index cache, but does not alter project
  // source or external state, so it remains approval-free and sequential.
  search_code: READ_SEQUENTIAL,
  index_workspace: MUTATING,
  remember: MUTATING,
  recall: READ_PARALLEL,
  task_add: MUTATING,
  task_done: MUTATING,
  task_list: READ_PARALLEL,
  spawn_agents: MUTATING,
  // Session-local UI state only; it is intentionally approval-free.
  set_todos: INTERACTIVE,
  propose_plan: INTERACTIVE,
  browser_console: READ_SEQUENTIAL,
  browser_network: READ_SEQUENTIAL,
  browser_performance: READ_SEQUENTIAL,
  update_profile: MUTATING,
  search_via_chrome: MUTATING,
  generate_image: MUTATING,
});

export function toolPolicy(name: string): ToolPolicy {
  return TOOL_POLICIES[name] ?? MUTATING;
}

export function requiresToolPermission(name: string): boolean {
  return toolPolicy(name).permission === "required";
}

export function isParallelSafeTool(name: string): boolean {
  return toolPolicy(name).parallel;
}

export function isClassifiedTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_POLICIES, name);
}
