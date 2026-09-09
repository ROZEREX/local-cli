// Static browser contract checks. These intentionally target security and
// accessibility outcomes rather than exact class names or visual styling, so
// the workbench can evolve without turning this into a snapshot test.
import { readFileSync } from "fs";
import { join } from "path";

const root = import.meta.dir;
const app = readFileSync(join(root, "ui-web", "public", "app.js"), "utf8");
const html = readFileSync(join(root, "ui-web", "public", "index.html"), "utf8");
const css = readFileSync(join(root, "ui-web", "public", "styles.css"), "utf8");
const extension = readFileSync(join(root, "extension", "background.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

function openingTag(id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<[a-z][^>]*\\bid=["']${escaped}["'][^>]*>`, "i"))?.[0] ?? "";
}

function hasAttr(tag: string, name: string, value?: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (value === undefined) return new RegExp(`\\b${escaped}(?:\\s*=|\\s|>)`, "i").test(tag);
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*=\\s*["']${v}["']`, "i").test(tag);
}

function controlHasName(id: string): boolean {
  const tag = openingTag(id);
  if (!tag) return false;
  if (hasAttr(tag, "aria-label") || hasAttr(tag, "title")) return true;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = html.match(new RegExp(`<button[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/button>`, "i"))?.[1] ?? "";
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length > 0;
}

// ── Authenticated client transport ─────────────────────────────────────────
check("client bootstraps a same-origin capability token", /\/api\/bootstrap/.test(app) && /X-Local-CLI-Token/.test(app));
check("websocket sends token and stable clientId", /\/ws\?[^`\n]*(?:token|encodeURIComponent)/.test(app) && /clientId/.test(app));
check("browser extension authenticates its bridge", /\/api\/bootstrap/.test(extension) && /\/ext\?[^`\n]*(?:token|encodeURIComponent)/.test(extension));
const directProtectedFetches = [...app.matchAll(/\bfetch\s*\(\s*([`"'])(\/api\/[^`"']+)\1/g)]
  .map(match => match[2])
  .filter(path => path !== "/api/bootstrap");
check("protected REST calls go through the authenticated wrapper", directProtectedFetches.length === 0, directProtectedFetches.join(", "));

// ── Markdown / DOM-XSS boundary ────────────────────────────────────────────
const markdownStart = app.indexOf("// ── markdown");
const markdownEnd = app.indexOf("const atBottom", Math.max(0, markdownStart));
const markdown = markdownStart >= 0 && markdownEnd > markdownStart ? app.slice(markdownStart, markdownEnd) : app;
check("markdown escapes attribute quotes", /&quot;/.test(markdown) && /(?:&#39;|&#x27;|&apos;)/i.test(markdown));
check("markdown links use an explicit URL policy", /(?:safe|sanitize|allowed)[A-Za-z]*(?:Url|Href|Link)/i.test(markdown)
  && /new URL\s*\(/.test(markdown)
  && /https?:/.test(markdown));
check("rendered links isolate the opener", /noopener/.test(markdown) && /noreferrer/.test(markdown));
check("known raw markdown href interpolation is absent", !/href=["']\$2["']/.test(markdown));
check("reasoning text is rendered as text, not HTML", /\.think\.textContent\s*=/.test(app));

// ── Typed lifecycle is actually consumed by the browser ───────────────────
for (const event of ["run_start", "phase", "heartbeat", "progress", "usage", "run_end"]) {
  check(`client handles ${event}`, new RegExp(`case\\s+["']${event}["']`).test(app));
}
check("terminal run outcome distinguishes cancellation and errors", /outcome/.test(app) && /cancelled/.test(app) && /error/.test(app));
check("reasoning UI labels its provenance", /reasoningSource|reasoning-source|reasoning provenance/i.test(app));
check("tool renderer correlates results by toolId", /function\s+addTool\s*\([^)]*toolId/.test(app)
  && /function\s+fillTool\s*\([^)]*toolId/.test(app)
  && /m\.toolId/.test(app));
check("plan approval exposes approve/keep/reject decisions", /case\s+["']plan_approval["']/.test(app)
  && /plan_decision/.test(app)
  && ["approve", "keep", "reject"].every(decision => app.includes(decision)));

// ── Document semantics and keyboard accessibility ──────────────────────────
const messageTag = openingTag("messages");
check("transcript is an incremental polite log", hasAttr(messageTag, "role", "log") && hasAttr(messageTag, "aria-live", "polite"), messageTag);
const liveTag = openingTag("live");
check("live phase is an announced status", hasAttr(liveTag, "role", "status") && hasAttr(liveTag, "aria-live", "polite"), liveTag);
const modalTag = openingTag("modal-card");
check("modal uses dialog semantics", hasAttr(modalTag, "role", "dialog") && hasAttr(modalTag, "aria-modal", "true")
  && (hasAttr(modalTag, "aria-labelledby") || hasAttr(modalTag, "aria-label")), modalTag);
check("composer input has an accessible name", hasAttr(openingTag("input"), "aria-label") || /<label[^>]*for=["']input["']/i.test(html));
for (const id of ["sidebar-toggle", "dashboard-toggle", "attach", "send", "stop"]) {
  check(`${id} control has an accessible name`, controlHasName(id), openingTag(id));
}
check("reasoning disclosure is a semantic button", /<button[^>]*class=["'][^"']*think-header/i.test(app) && /aria-expanded/.test(app));
check("reasoning disclosure keeps aria-expanded in sync", /setAttribute\s*\(\s*["']aria-expanded["']/.test(app));
check("modal supports Escape and restores or moves focus", /Escape/.test(app) && /\.focus\s*\(/.test(app));

// ── Responsive workbench contracts ─────────────────────────────────────────
check("viewport opts into device width", /name=["']viewport["'][^>]*width=device-width/i.test(html));
check("workbench uses dynamic viewport height", /100dvh/.test(css) || /100dvh/.test(html));
const maxWidthBreakpoints = [...css.matchAll(/@media\s*\([^)]*max-width\s*:\s*([\d.]+)px/gi)].map(match => Number(match[1]));
check("tablet and phone layouts have explicit breakpoints", maxWidthBreakpoints.some(value => value >= 900 && value <= 1024)
  && maxWidthBreakpoints.some(value => value >= 360 && value <= 640), JSON.stringify(maxWidthBreakpoints));
check("mobile interactive targets reach 44px", /(?:min-)?height\s*:\s*(?:44px|2\.75rem)/i.test(css));
check("reduced-motion preference is respected", /prefers-reduced-motion\s*:\s*reduce/i.test(css));
check("keyboard focus has a visible treatment", /:focus-visible/.test(css));

console.log(`\n${fail === 0 ? "WEB UI CONTRACT OK" : "WEB UI CONTRACT FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
