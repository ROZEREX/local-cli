// Parses tool calls from a model's text output for prompted tool-calling
// (models without native function support).
//
// PRIMARY format = XML-ish tags with RAW (unescaped) bodies — this is what local
// code models reliably produce, because they don't have to JSON-escape a whole
// file into a string:
//   <write_file path="timer.html">
//   ...raw file content...
//   </write_file>
//   <edit_file path="a.js"><search>old</search><replace>new</replace></edit_file>
//   <bash>npm test</bash>
//   <read_file path="x"></read_file>
//
// FALLBACKS (kept for robustness): <tool_call>{json}</tool_call>, ```json fences,
// and a bare {"name","arguments"} object.

import { canonicalToolName } from "./tools/executor";
import { TOOL_DEFINITIONS } from "./tools/definitions";

export interface ParsedToolCall {
  name: string;
  arguments: any;
}

export const TOOL_NAMES = [
  "read_file", "write_file", "edit_file", "glob_files",
  "grep_files", "list_dir", "bash", "delete_file",
  "run_server", "server_logs", "stop_server", "list_servers",
  "read_profile", "update_profile", "ask_user", "list_ports", "kill_port",
  "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot", "browser_close", "screenshot",
  "system_info", "page_read", "page_find", "page_click", "page_type", "page_highlight", "page_scroll",
  "page_open", "page_navigate",
  "search_code", "index_workspace", "remember", "recall",
  "task_add", "task_done", "task_list", "spawn_agents",
  "set_todos", "propose_plan",
  "browser_console", "browser_network", "browser_performance",
  "search_via_chrome",
];

function stripEdgeNewlines(s: string): string {
  return s.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

// If a model wraps a whole file body in a single ```lang ... ``` markdown fence
// (common with code models), unwrap it so the fence markers don't end up in the
// file and cause syntax errors. Only unwraps when the ENTIRE body is one fence.
function stripWrappingFence(s: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\r?\n?```\s*$/.exec(s);
  return m ? m[1]! : s;
}

// Accept double quotes, single quotes, OR unquoted values — models vary.
function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) attrs[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

// Resolve a `path` arg from common aliases or a <path>…</path> child tag, so a
// missing/odd path attribute doesn't make the whole edit fail.
function resolvePathArg(args: any, body: string) {
  if (args.path) return;
  for (const a of ["file", "filename", "filepath", "file_path", "target"]) {
    if (args[a]) { args.path = args[a]; return; }
  }
  const m = /<path>\s*([\s\S]*?)\s*<\/path>/.exec(body);
  if (m) args.path = m[1]!.trim();
}

// ─── XML tool tags (primary) ──────────────────────────────────────────────────
function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const re = new RegExp(`<(${TOOL_NAMES.join("|")})\\b([^>]*)>([\\s\\S]*?)</\\1>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!;
    const attrs = parseAttrs(m[2] ?? "");
    const body = m[3] ?? "";
    const args: any = {};
    for (const [k, v] of Object.entries(attrs)) {
      args[k] = (k === "offset" || k === "limit") ? Number(v) : v;
    }
    if (name === "write_file") {
      // content may also arrive as a <content>…</content> child tag.
      const cm = /<content>([\s\S]*?)<\/content>/.exec(body);
      args.content = stripEdgeNewlines(stripWrappingFence(cm ? cm[1]! : body));
    } else if (name === "bash") {
      if (!args.command) args.command = body.trim();
    } else if (name === "edit_file") {
      const s = /<search>([\s\S]*?)<\/search>/.exec(body);
      const r = /<(replace|replace_with|new_string)>([\s\S]*?)<\/\1>/.exec(body);
      if (s) args.old_string = stripEdgeNewlines(s[1]!);
      if (r) args.new_string = stripEdgeNewlines(r[2]!);
    } else if (name === "update_profile") {
      // The tag body is the profile text to save.
      if (!args.content) args.content = stripEdgeNewlines(body);
    } else if (name === "ask_user") {
      // Options are the body, separated by | or newlines (question is an attr).
      if (!args.options) args.options = stripEdgeNewlines(body).split(/\||\n/).map(s => s.trim()).filter(Boolean);
    } else if (name === "remember") {
      // The tag body is the fact(s) to save.
      if (!args.content) args.content = stripEdgeNewlines(body);
    } else if (name === "task_add") {
      if (!args.text) args.text = stripEdgeNewlines(body).trim();
    } else if (name === "task_done") {
      if (!args.task) args.task = stripEdgeNewlines(body).trim();
    } else if (name === "search_code" || name === "search_via_chrome") {
      if (!args.query) args.query = stripEdgeNewlines(body).trim();
    } else if (name === "spawn_agents") {
      // One task per line (or separated by |) in the body.
      if (!args.tasks) args.tasks = stripEdgeNewlines(body).split(/\||\n/).map(s => s.trim()).filter(Boolean);
    } else if (name === "set_todos") {
      // One checklist item per line: "[ ] pending", "[>] in progress", "[x] done".
      if (!args.todos) args.todos = stripEdgeNewlines(body).split(/\n/).map(s => s.trim()).filter(Boolean);
    } else if (name === "propose_plan") {
      // The tag body is the full plan markdown.
      if (!args.plan) args.plan = stripEdgeNewlines(body);
    }
    resolvePathArg(args, body);
    calls.push({ name, arguments: args });
  }
  return calls;
}

// ─── JSON fallbacks ───────────────────────────────────────────────────────────
function extractBalancedObject(s: string, from = 0): { json: string; end: number } | null {
  const start = s.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { json: s.slice(start, i + 1), end: i + 1 }; }
  }
  return null;
}

function asToolCall(jsonStr: string): ParsedToolCall | null {
  try {
    const o = JSON.parse(jsonStr);
    if (o && typeof o.name === "string") {
      const args = o.arguments ?? o.parameters ?? {};
      if (typeof args === "object" && args !== null) return { name: o.name, arguments: args };
    }
  } catch { /* not JSON */ }
  return null;
}

function collectCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = extractBalancedObject(text, cursor);
    if (!found) break;
    const call = asToolCall(found.json);
    if (call) calls.push(call);
    cursor = found.end;
  }
  return calls;
}

export function parseToolCalls(content: string): ParsedToolCall[] {
  // 1. XML tool tags (the format we instruct).
  const xml = parseXmlToolCalls(content);
  if (xml.length) return xml;

  // 2. <tool_call>{json}</tool_call> — also <tool_calls> and <tools> (some
  //    chat templates, e.g. certain Qwen AWQ builds served by vLLM, emit the
  //    call wrapped in <tools>…</tools> in CONTENT with an empty native
  //    tool_calls field, so we recover it here).
  const tagRe = /<(tool_call|tool_calls|tools)>\s*([\s\S]*?)\s*<\/\1>/gi;
  const tagged: ParsedToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content)) !== null) {
    const inner = m[2] ?? "";
    const call = asToolCall(inner) ?? collectCalls(inner)[0];
    if (call) tagged.push(call);
  }
  if (tagged.length) return tagged;

  // 3. ```json fenced blocks
  const fenceRe = /```(?:json|tool_call)?\s*([\s\S]*?)```/g;
  const fenced: ParsedToolCall[] = [];
  while ((m = fenceRe.exec(content)) !== null) fenced.push(...collectCalls(m[1] ?? ""));
  if (fenced.length) return fenced;

  // 4. bare object, only if the content is basically just JSON
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    const bare = collectCalls(trimmed);
    if (bare.length) return bare;
  }
  return [];
}

export function hasToolCall(content: string): boolean {
  return parseToolCalls(content).length > 0;
}

// ─── Leaked tool call recovery (gpt-oss / harmony) ────────────────────────────
// Each tool's required params and the full set of param names it accepts,
// derived from the schemas. Tools with no required param are excluded — their
// shape is too loose to infer safely.
const TOOL_ARG_SIGNATURES = TOOL_DEFINITIONS.map((t) => {
  const fn: any = (t as any).function;
  const props = fn?.parameters?.properties ?? {};
  return {
    name: fn.name as string,
    required: (fn?.parameters?.required ?? []) as string[],
    allowed: Object.keys(props),
  };
}).filter((s) => s.required.length > 0);

// gpt-oss/harmony on Ollama sometimes emits a tool call's ARGUMENTS as a bare
// JSON object in the content channel: the function name lived in the dropped
// channel header ("…to=functions.write_file…"), so we get {"path":…,"content":…}
// with no `name` and the call dead-ends as a "final answer". Recover it by
// matching the argument shape to exactly one tool. Deliberately strict to avoid
// turning a legitimate JSON answer into an action:
//   - the ENTIRE text must be a single JSON object (not JSON embedded in prose),
//   - it must have NO `name` key (a named call is handled by parseToolCalls),
//   - every required param of the tool must be present,
//   - every key must be a known param of that tool (no foreign keys), and
//   - exactly ONE tool may match (ambiguous shapes like {command} are skipped).
// Mutating tools still hit the permission prompt downstream, so a wrong guess is
// shown to the user as a diff before anything happens.
export function parseLeakedToolCall(content: string): ParsedToolCall[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return [];
  const found = extractBalancedObject(trimmed, 0);
  if (!found || found.end < trimmed.length) return []; // must be the whole text
  let obj: any;
  try { obj = JSON.parse(found.json); } catch { return []; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  if (typeof obj.name === "string") return []; // named → parseToolCalls handles it
  const keys = Object.keys(obj);
  if (keys.length === 0) return [];
  const matches = TOOL_ARG_SIGNATURES.filter(
    (sig) => sig.required.every((r) => keys.includes(r)) && keys.every((k) => sig.allowed.includes(k))
  );
  if (matches.length !== 1) return []; // none or ambiguous → don't guess
  return [{ name: matches[0]!.name, arguments: obj }];
}

// True when `text` parses to a call for a KNOWN tool (after alias normalization).
// Used to recognize a narrated tool call (e.g. a ```json block) vs. a real code
// block the user actually wants to see.
export function isToolCallText(text: string): boolean {
  const calls = parseToolCalls(text);
  return calls.length > 0 && calls.some(c => TOOL_NAMES.includes(canonicalToolName(c.name)));
}

// ─── Narration filter ─────────────────────────────────────────────────────────
// Some models (e.g. qwen-coder) PRINT a tool call as a ```json … ``` block in
// their visible text instead of using the tool interface. We still execute those
// (see the native fallback), but they shouldn't flood the screen. This streaming
// filter passes prose and genuine code fences through, but drops a fenced block
// whose contents parse as a known tool call. Boundary-safe across chunks.
export class NarrationFilter {
  private buf = "";

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (true) {
      const start = this.buf.indexOf("```");
      if (start === -1) {
        // Emit all but up to 2 trailing backticks (possible start of a fence).
        let trailing = 0;
        for (let i = this.buf.length - 1; i >= 0 && this.buf.length - i <= 2 && this.buf[i] === "`"; i--) trailing++;
        const emitLen = this.buf.length - trailing;
        out += this.buf.slice(0, emitLen);
        this.buf = this.buf.slice(emitLen);
        break;
      }
      out += this.buf.slice(0, start);
      const close = this.buf.indexOf("```", start + 3);
      if (close === -1) { this.buf = this.buf.slice(start); break; } // incomplete fence — hold
      const block = this.buf.slice(start, close + 3);
      const inner = this.buf.slice(start + 3, close).replace(/^[ \t]*[a-zA-Z0-9_]*[ \t]*\r?\n/, "");
      if (!isToolCallText(inner.trim())) out += block; // keep real code; drop tool-call narration
      this.buf = this.buf.slice(close + 3);
    }
    return out;
  }

  flush(): string {
    const o = this.buf;
    this.buf = "";
    if (o.startsWith("```")) {
      const inner = o.slice(3).replace(/^[ \t]*[a-zA-Z0-9_]*[ \t]*\r?\n/, "");
      if (isToolCallText(inner.trim())) return "";
    }
    return o;
  }
}

// ─── Prose filter ─────────────────────────────────────────────────────────────
// During streaming we want to show the model's prose but hide raw tool-call
// markup. Tool calls come at/after the prose, so: emit text until the first tool
// opening tag, then suppress. Boundary-safe across chunks.
export class ProseFilter {
  private buffer = "";
  private done = false;
  private readonly openTags: string[];
  private readonly maxLen: number;

  constructor() {
    this.openTags = [...TOOL_NAMES.map(n => `<${n}`), "<tool_call"];
    this.maxLen = Math.max(...this.openTags.map(t => t.length));
  }

  push(chunk: string): string {
    if (this.done) return "";
    this.buffer += chunk;

    let firstIdx = -1;
    for (const t of this.openTags) {
      const i = this.buffer.indexOf(t);
      if (i !== -1 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
    }
    if (firstIdx !== -1) {
      const out = this.buffer.slice(0, firstIdx);
      this.buffer = "";
      this.done = true;
      return out;
    }

    const lastLt = this.buffer.lastIndexOf("<");
    let holdFrom = this.buffer.length;
    if (lastLt !== -1 && this.buffer.length - lastLt < this.maxLen) {
      const tail = this.buffer.slice(lastLt);
      if (this.openTags.some(t => t.startsWith(tail))) holdFrom = lastLt;
    }
    const out = this.buffer.slice(0, holdFrom);
    this.buffer = this.buffer.slice(holdFrom);
    return out;
  }

  flush(): string {
    if (this.done) return "";
    const o = this.buffer;
    this.buffer = "";
    return o;
  }
}
