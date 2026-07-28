// Incognito mode — a session that leaves nothing on disk.
//
// This module is deliberately dependency-free (it imports nothing from the rest
// of the codebase) so every persistence module can guard itself against it
// without creating an import cycle. The rule is: the GUARD LIVES AT THE WRITER,
// never at the caller. Any code path — web UI, terminal CLI, a tool the model
// invoked on its own — hits the same check, so a new caller can't accidentally
// bypass incognito by forgetting to ask.
//
// Scope, stated honestly: incognito suppresses the traces THIS app writes and
// the network calls THIS app makes. It is not a sandbox. Files the agent writes
// because you asked it to are still real files (see NOT_PROTECTED).

export interface IncognitoState {
  on: boolean;
  since: number | null;
}

let _on = false;
let _since: number | null = null;

export function isIncognito(): boolean {
  return _on;
}

export function incognitoState(): IncognitoState {
  return { on: _on, since: _since };
}

// Returns true when the flag actually changed.
export function setIncognito(on: boolean): boolean {
  if (_on === on) return false;
  _on = on;
  _since = on ? Date.now() : null;
  return true;
}

// Standard refusal handed back to the model when it reaches for something
// incognito withholds. Phrased so the model adapts instead of retrying.
export function incognitoBlock(what: string, alternative = ""): string {
  return `Blocked: incognito mode is on, so ${what} is disabled for this session — nothing may be written to disk or sent off this machine.${alternative ? ` ${alternative}` : ""} Don't retry; tell the user it needs incognito turned off.`;
}

// ── What the mode actually does ──────────────────────────────────────────────
// Both lists are surfaced verbatim in the UI. Keep them accurate: the value of
// this feature is that the disclosure is true, not that the list is long.

export const SUPPRESSED: { label: string; detail: string }[] = [
  { label: "Chat transcripts", detail: "Nothing is written to ~/.local-cli/sessions/ — the conversation lives in RAM only and dies with the tab." },
  { label: "Config changes", detail: "Model, mode, folder and settings changes stay in memory; config.json is untouched and restored on exit." },
  { label: "Project memory", detail: "The remember tool is disabled — .local-cli/memory.md is not created or appended to." },
  { label: "Coding profiles", detail: "update_profile and profile learning are disabled — ~/.local-cli/profiles/ is untouched." },
  { label: "Undo snapshots", detail: "File edits are NOT snapshotted to .local-cli/history/ (which would otherwise store full file contents). Trade-off: /undo is unavailable." },
  { label: "Code index", detail: "The embedding index is kept in memory and never written to .local-cli/index.json." },
  { label: "Task list", detail: "task_add / task_done don't touch .local-cli/tasks.md." },
  { label: "Web search traces", detail: "The agent can still look things up, but through a throwaway headless browser with its own profile that is deleted afterwards — nothing lands in your real Chrome's history, cookies or cache." },
];

export const NOT_PROTECTED: { label: string; detail: string }[] = [
  { label: "Files the agent writes", detail: "write_file, edit_file, delete_file and bash make real changes to your project. Incognito is not a sandbox — and with undo snapshots off, those changes are not recoverable through this app." },
  { label: "Your inference server", detail: "Prompts still go to the configured backend. Local Ollama/vLLM keeps them on this machine, but the server may keep its own logs. A remote backend URL means your text leaves the box — the banner warns when that's the case." },
  { label: "What you search for", detail: "A web search has to reach a search engine, so DuckDuckGo and the sites visited see the query and your IP. The private browser hides the search from your machine, not from the internet. Never ask it to look up a secret." },
  { label: "Anything bash does", detail: "A command you approve can write files, hit the network, or append to a shell history of its own. Incognito doesn't inspect what a command does." },
  { label: "This browser tab", detail: "The transcript is in the page's memory and in your OS's RAM until you close the tab. Screenshots the agent takes are held there too." },
  { label: "Other running tabs", detail: "Incognito is process-wide by design — while it's on, every connected tab is in it, so a second tab can't quietly persist the same conversation." },
];

// ── Inference-destination check ──────────────────────────────────────────────
// "Nothing leaves the machine" is only true if the model is on this machine.
// Take the baseUrl as an argument (rather than reading config) to keep this
// module free of imports.
export function inferenceIsLocal(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" ||
      host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

// A one-line warning when the backend is off-box, or "" when it's local.
export function remoteBackendWarning(baseUrl: string): string {
  if (inferenceIsLocal(baseUrl)) return "";
  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch {}
  return `Your model backend is ${host}, which is not this machine — every prompt in this session is sent there. Incognito cannot make that private. Point the backend at localhost for a genuinely offline session.`;
}
