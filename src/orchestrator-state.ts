// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator state: per-conversation failure tracking + green-field detection,
// and the dynamic <RUNTIME_OVERRIDE> blocks the loop injects into the system
// prompt based on that state.
//
// This is deliberately a tiny module-level singleton (one conversation runs in a
// process at a time in this CLI). chat() feeds it the newest genuine user turn
// and every tool outcome; the turn builders read buildRuntimeOverride() to append
// request-only guidance. Reset it on /new and on session resume so state from one
// chat never bleeds into the next.
// ─────────────────────────────────────────────────────────────────────────────

export interface OrchestratorState {
  /** Consecutive failure signals (user "not working" / non-zero build exit). Reset to 0 on a successful run. */
  errorStreak: number;
  /** The initial user request looked like a green-field ("create/from scratch/…") ask. */
  isFromScratch: boolean;
  /** True until the green-field architectural-manifest turn has been forced + the user replies again. */
  awaitingScaffold: boolean;
  /** The framework/library name the last failure was about, so the forced search can target it. */
  lastFailingSubject: string | null;
}

const state: OrchestratorState = {
  errorStreak: 0,
  isFromScratch: false,
  awaitingScaffold: false,
  lastFailingSubject: null,
};

export function getOrchestratorState(): Readonly<OrchestratorState> {
  return state;
}

/**
 * True while the green-field manifest gate is armed. The loop uses this to NOT
 * "anti-stall" nudge a turn that correctly ends with a manifest and no tool call
 * (halting for confirmation is the desired behaviour here, not a stall).
 */
export function isAwaitingScaffold(): boolean {
  return state.awaitingScaffold;
}

export function resetOrchestratorState(): void {
  state.errorStreak = 0;
  state.isFromScratch = false;
  state.awaitingScaffold = false;
  state.lastFailingSubject = null;
}

// The user is telling us something is broken. Kept broad but anchored to whole
// words so ordinary prose ("no errors now") is less likely to trip it — the
// build-exit signal below is the more reliable of the two.
const FAILURE_RE =
  /\b(not working|does(?:n'?t| not) work|is(?:n'?t| not) working|still (?:broken|not working|failing|fails)|broke(?:n)?|failed|failing|fails|crash(?:e[sd])?|throws?|threw|exception|won'?t (?:build|run|start|compile|load)|can'?t (?:build|run|start|compile)|blank (?:screen|page)|undefined is not)\b/i;

// A brand-new / green-field request. Deliberately strict: it needs an explicit
// green-field phrase, OR a creation verb followed closely by an INDEFINITE
// project-shaped noun ("build a todo app", "create an API"). Bare verbs are NOT
// enough — first messages like "fix the build", "make the tests pass", or
// "start the app" must never arm the manifest gate (which blocks all writes).
const FROM_SCRATCH_RE =
  /\b(?:from scratch|green ?field|scaffold|bootstrap)\b|\b(?:create|build|make|write|develop|design|set ?up|initiali[sz]e|init|start)\b[^.!?\n]{0,40}?\b(?:a|an|another|new)\s+(?:\w+[- ]){0,3}?(?:project|app|application|web ?site|site|web ?page|landing page|game|api|service|tool|cli|dashboard|store|shop|blog|portfolio|bot|extension|plugin)\b/i;

// Commands whose non-zero exit is a real "the build/tests failed" signal (as
// opposed to an unrelated shell command that happened to exit non-zero).
const BUILD_CMD_RE =
  /\b(build|compile|tsc|typecheck|type-check|vite|webpack|rollup|esbuild|next (?:build|dev)|npm (?:run )?(?:build|test|lint)|bun (?:run )?(?:build|test)|pnpm (?:run )?(?:build|test)|yarn (?:build|test)|test|jest|vitest|pytest|lint|eslint|cargo (?:build|test)|go build|mvn|gradle|make)\b/i;

// Try to name the framework/library at fault so the forced doc-search is targeted.
const FRAMEWORK_RE =
  /\b(tailwind(?:css)?|next\.?js|react|vue|svelte(?:kit)?|angular|astro|remix|vite|webpack|express|fastify|nest(?:js)?|prisma|drizzle|mongoose|django|flask|fastapi|rails|laravel|spring|bun|deno|typescript|eslint|jest|vitest|playwright|three\.?js|shadcn)\b/i;

function extractSubject(text: string): string | null {
  const m = text.match(FRAMEWORK_RE);
  return m ? m[0] : null;
}

/**
 * Feed the newest genuine USER message (not an internal nudge/tool-response) to
 * the state machine. `isFirstUserTurn` must be true only for the very first user
 * message of the conversation.
 */
export function noteUserTurn(text: string, isFirstUserTurn: boolean): void {
  if (typeof text !== "string") return;

  if (isFirstUserTurn) {
    state.isFromScratch = FROM_SCRATCH_RE.test(text);
    // Arm the one-shot "produce an architecture manifest first" gate.
    state.awaitingScaffold = state.isFromScratch;
  } else {
    // Any later user message means they've replied to the manifest (or moved on):
    // release the green-field halt so the model can write real code now.
    state.awaitingScaffold = false;
  }

  if (FAILURE_RE.test(text)) {
    state.errorStreak++;
    const subj = extractSubject(text);
    if (subj) state.lastFailingSubject = subj;
  }
}

// A bash result string counts as a failure when bashExec prefixed it with a
// non-zero exit code, a timeout, or a spawn error (see tools/executor.ts).
function bashFailed(result: string): boolean {
  return /^Exit \d/.test(result) || /^Command timed out/.test(result) || /^Error executing command/.test(result);
}

/**
 * Feed every tool outcome to the state machine. A failing build/test bumps the
 * streak; a clean build/test resets it to 0. Non-build commands are ignored so a
 * routine `git status` exiting non-zero doesn't trigger the two-strike override.
 */
export function noteToolOutcome(name: string, args: any, result: string): void {
  if (typeof result !== "string") return;

  if (name === "bash") {
    const cmd = String(args?.command ?? "");
    if (!BUILD_CMD_RE.test(cmd)) return; // only build/test commands move the needle
    if (bashFailed(result)) {
      state.errorStreak++;
      const subj = extractSubject(cmd) || extractSubject(result);
      if (subj) state.lastFailingSubject = subj;
    } else {
      state.errorStreak = 0; // a successful run clears the streak
    }
    return;
  }

  if (name === "run_server") {
    // run_server reports an immediate crash as "exited immediately" — treat that
    // as a build failure; a clean start clears the streak.
    if (/exited immediately/i.test(result)) state.errorStreak++;
    else if (/started and is running/i.test(result)) state.errorStreak = 0;
    return;
  }

  // Any search attempt disarms the two-strike override. On success the docs
  // were read — give the informed fix a chance before re-arming (the streak
  // rebuilds from fresh failures if the fix still doesn't work). On ERROR the
  // tool is unavailable (e.g. no Chrome installed) — keeping the streak would
  // deadlock the conversation into demanding the same failing tool every turn.
  if (name === "search_via_chrome") {
    state.errorStreak = 0;
  }
}

// Gentle first-strike nudge: after ONE failure the model's assumptions are
// suspect, so steer it toward verification (real error text, real code, real
// versions, docs) BEFORE the next attempt — without yet locking anything out.
// The hard two-strike force below only fires if this doesn't work.
const ONE_STRIKE_HINT = (subject: string | null) => `<RUNTIME_OVERRIDE priority="high">
Your previous attempt at this failed (error_streak=1). Do NOT re-apply the same idea unchanged, and do not write the next fix purely from memory. Before you edit anything: re-read the ACTUAL error output, read the real code/config involved, and check the installed version (package.json / lockfile). If the failure involves ${subject ? `${subject}'s` : "a framework's or library's"} API or configuration, fetch its current official docs with search_via_chrome and read them first. Then fix based on what you verified.
</RUNTIME_OVERRIDE>`;

const TWO_STRIKE_OVERRIDE = (streak: number, subject: string | null) => `<RUNTIME_OVERRIDE priority="max">
Two-strike rule tripped (error_streak=${streak}). The same problem${subject ? ` with ${subject}` : ""} has failed or been reported broken at least twice in a row. Your frozen training memory is demonstrably out of date for this and is LOCKED OUT for this problem. You are BANNED from writing a third blind fix from memory.
Your VERY NEXT action MUST be a single search_via_chrome tool call fetching the current official documentation for the failing framework/library${subject ? ` (search e.g. "${subject} <the specific thing that's failing>")` : ""}. You MUST read the live scraped text it returns before you edit or write any code. Do not apologize, do not re-explain the previous attempts — just issue the search_via_chrome call now.
</RUNTIME_OVERRIDE>`;

const SCAFFOLD_OVERRIDE = `<RUNTIME_OVERRIDE priority="max">
This is the first turn of a brand-new (green-field) project. You are STRICTLY FORBIDDEN from writing final, runnable file code on this turn. Do NOT call write_file or edit_file yet.
Output ONLY a structural architectural manifest, in this order: (1) the proposed file/folder tree, (2) the state / database schema, and (3) mock data arrays or example object shapes. Then STOP and ask the user to confirm the architecture before you write any real code.
</RUNTIME_OVERRIDE>`;

/**
 * The dynamic system-prompt override for the CURRENT turn, or "" when neither
 * rule applies. Recomputed every turn because errorStreak can cross the
 * threshold mid-loop (e.g. after a failed build). Appended request-only.
 */
export function buildRuntimeOverride(): string {
  const parts: string[] = [];
  if (state.errorStreak >= 2) parts.push(TWO_STRIKE_OVERRIDE(state.errorStreak, state.lastFailingSubject));
  else if (state.errorStreak === 1) parts.push(ONE_STRIKE_HINT(state.lastFailingSubject));
  if (state.awaitingScaffold) parts.push(SCAFFOLD_OVERRIDE);
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}
