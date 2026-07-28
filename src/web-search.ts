// ─────────────────────────────────────────────────────────────────────────────
// search_via_chrome: live internet access by driving the user's REAL Google
// Chrome over the DevTools Protocol (CDP) — no search API, no Playwright, no
// browser download. It opens a *throwaway* tab in the already-running Chrome
// debug session, runs a query on DuckDuckGo's HTML endpoint, follows the top 1-2
// organic/documentation results, scrapes clean readable text, closes the tab,
// and returns the text straight to the model's context.
//
// Attaching to the user's real session requires Chrome to have been started with
// --remote-debugging-port=<PORT> (default 9222). If nothing is listening there we
// fall back to launching a Chromium-family browser with a throwaway profile on
// that port (same behaviour as src/browser.ts) — so this never wedges the user's
// main window, but also can't read their logged-in tabs.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findBrowser } from "./browser";

const DEBUG_PORT = Number(process.env.LOCAL_CLI_CDP_PORT ?? 9222);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A browser we launched ourselves for search (only used when the user isn't
// already running Chrome with the debug port). Kept so we don't relaunch.
let launchedChild: ChildProcess | null = null;

interface CdpTarget { id: string; type: string; url: string; webSocketDebuggerUrl?: string; }

async function endpointUp(port = DEBUG_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
}

// Make sure *something* is listening on the CDP port. Prefer whatever is already
// there (the user's real Chrome); otherwise launch one with a temp profile.
async function ensureChrome(): Promise<void> {
  if (await endpointUp()) return;
  const exe = findBrowser();
  if (!exe) {
    throw new Error(
      `No Chrome/Edge/Chromium found, and nothing is listening on the debug port ${DEBUG_PORT}. ` +
      `Start Chrome with --remote-debugging-port=${DEBUG_PORT} (to use your real session), or install Chrome.`
    );
  }
  const dir = join(tmpdir(), "localcli-search-chrome");
  launchedChild = spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank",
  ], { detached: false, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    if (await endpointUp()) return;
    await sleep(250);
  }
  throw new Error(`Launched a browser but its debugger never came up on port ${DEBUG_PORT}.`);
}

// ── private (incognito) search session ───────────────────────────────────────
// A search run in incognito must NEVER attach to the user's real Chrome — doing
// so would write the visit into their actual history, which is exactly the trace
// the mode exists to avoid. So we run a completely separate browser: its own CDP
// port, --incognito, and a throwaway profile directory that is deleted when the
// session ends. What this CANNOT hide is the query itself: a web search has to
// reach a search engine, and that engine sees the request. Callers disclose it.
const PRIVATE_PORT = Number(process.env.LOCAL_CLI_CDP_PRIVATE_PORT ?? DEBUG_PORT + 771);

let privateChild: ChildProcess | null = null;
let privateProfileDir: string | null = null;

async function ensurePrivateChrome(): Promise<number> {
  if (privateChild && !privateChild.killed && (await endpointUp(PRIVATE_PORT))) return PRIVATE_PORT;
  // Refuse to reuse whatever might already be on the port — it could be the
  // user's own browser, and we'd be writing into their profile.
  if (!privateChild && (await endpointUp(PRIVATE_PORT))) {
    throw new Error(
      `Port ${PRIVATE_PORT} is already in use by another browser, so a private search can't be isolated. ` +
      `Free it, or set LOCAL_CLI_CDP_PRIVATE_PORT to an unused port.`
    );
  }
  const exe = findBrowser();
  if (!exe) throw new Error("No Chrome/Edge/Chromium found — a private search needs a Chromium-family browser to launch.");

  privateProfileDir = mkdtempSync(join(tmpdir(), "localcli-private-"));
  privateChild = spawn(exe, [
    `--remote-debugging-port=${PRIVATE_PORT}`,
    `--user-data-dir=${privateProfileDir}`,
    "--incognito",
    "--no-first-run", "--no-default-browser-check",
    // Keep it out of the way and away from the user's signed-in identity.
    "--disable-sync", "--no-service-autorun", "--disable-extensions",
    "--headless=new",
    "about:blank",
  ], { detached: false, stdio: "ignore" });

  for (let i = 0; i < 40; i++) {
    if (await endpointUp(PRIVATE_PORT)) return PRIVATE_PORT;
    await sleep(250);
  }
  await closePrivateChrome();
  throw new Error(`Launched a private browser but its debugger never came up on port ${PRIVATE_PORT}.`);
}

// Kill the private browser and delete its profile directory. Safe to call twice.
export async function closePrivateChrome(): Promise<void> {
  try { privateChild?.kill(); } catch {}
  privateChild = null;
  const dir = privateProfileDir;
  privateProfileDir = null;
  if (!dir) return;
  // Chrome needs a moment to release its file handles on Windows before the
  // profile can be removed; retry briefly rather than leaving the dir behind.
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); if (!existsSync(dir)) return; } catch {}
    await sleep(250);
  }
}

export function privateSearchActive(): boolean {
  return privateChild !== null;
}

// Open a new throwaway tab (at about:blank) and return its target id + ws url.
// Modern Chrome requires PUT for /json/new; fall back to GET for old builds.
async function openTab(port = DEBUG_PORT): Promise<CdpTarget> {
  const url = `http://localhost:${port}/json/new?about:blank`;
  let res = await fetch(url, { method: "PUT" }).catch(() => null);
  if (!res || !res.ok) res = await fetch(url).catch(() => null); // legacy Chrome
  if (!res || !res.ok) throw new Error(`Could not open a new Chrome tab (HTTP ${res?.status ?? "no response"}).`);
  const t = (await res.json()) as CdpTarget;
  if (!t.webSocketDebuggerUrl) throw new Error("New tab has no debugger websocket.");
  return t;
}

async function closeTab(id: string, port = DEBUG_PORT): Promise<void> {
  try { await fetch(`http://localhost:${port}/json/close/${id}`, { signal: AbortSignal.timeout(1500) }); } catch {}
}

// A minimal one-tab CDP client (send command by id, await matching reply). Scoped
// to a single search so it never interferes with src/browser.ts's own session.
class TabSession {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      const to = setTimeout(() => reject(new Error("CDP connect timed out")), 5000);
      sock.onopen = () => { clearTimeout(to); this.ws = sock; resolve(); };
      sock.onerror = () => { clearTimeout(to); reject(new Error("CDP connect failed")); };
      sock.onmessage = (ev: any) => {
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!; this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message || "CDP error")) : p.resolve(m.result);
        }
      };
    });
  }

  cmd(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("CDP not connected"));
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); } }, 20000);
    });
  }

  async evalJs(expression: string): Promise<any> {
    const r = await this.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r?.result?.value;
  }

  async navigate(url: string): Promise<void> {
    await this.cmd("Page.navigate", { url });
    // Wait for the document to be usable.
    for (let i = 0; i < 60; i++) {
      const s = await this.evalJs("document.readyState").catch(() => null);
      if (s === "complete" || s === "interactive") break;
      await sleep(150);
    }
    await sleep(400); // let late content settle
  }

  close(): void { try { this.ws?.close(); } catch {} this.pending.clear(); }
}

// Docs domains we prefer to click into when they show up in results.
const DOC_HOST_RE = /(^|\.)(docs?|developer|devdocs|readthedocs)\.|(tailwindcss|react|vuejs|svelte|angular|astro|remix|vitejs|nextjs|nodejs|mdn|mozilla|typescriptlang|prisma|expressjs|fastify|nestjs|python|djangoproject|flask|rust-lang|golang|go)\.(dev|org|io|com)/i;

// Extract the real destination from a DuckDuckGo HTML result href
// (//duckduckgo.com/l/?uddg=<encoded real url>&…).
function decodeDdgHref(href: string): string {
  try {
    const abs = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(abs, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : abs;
  } catch { return href; }
}

// In-page script: pull the visible, readable text out of a docs/article page,
// stripping chrome (nav/aside/script/etc.) and collapsing whitespace.
const EXTRACT_TEXT_JS = `(() => {
  const pick = document.querySelector('main, article, [role=main], .prose, #content, .content') || document.body;
  if (!pick) return '';
  const clone = pick.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,svg,form,button,iframe').forEach(n => n.remove());
  return (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' ').trim();
})()`;

export interface SearchResult {
  query: string;
  pages: { title: string; url: string; text: string }[];
  note?: string;
}

/**
 * Run `query` through the user's Chrome and return cleaned text from the top
 * 1-2 result pages (documentation preferred). `maxPages` caps how many result
 * links are followed (default 2). Never throws for "no results" — it returns a
 * note instead — but will throw if Chrome/CDP is unreachable.
 */
export async function searchViaChrome(
  query: string,
  maxPages = 2,
  opts: { private?: boolean } = {}
): Promise<SearchResult> {
  const q = (query ?? "").trim();
  if (!q) return { query: q, pages: [], note: "Empty query." };

  // Private runs get their own browser+profile; normal runs reuse the user's.
  const port = opts.private ? await ensurePrivateChrome() : (await ensureChrome(), DEBUG_PORT);
  const target = await openTab(port);
  const tab = new TabSession();

  try {
    await tab.connect(target.webSocketDebuggerUrl!);
    await tab.cmd("Page.enable").catch(() => {});
    await tab.cmd("Runtime.enable").catch(() => {});

    // If the query is itself a URL, just read that page.
    const looksLikeUrl = /^https?:\/\/\S+$/i.test(q);
    let links: string[] = [];

    if (looksLikeUrl) {
      links = [q];
    } else {
      await tab.navigate(`https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
      const raw: string[] = await tab.evalJs(
        `Array.from(document.querySelectorAll('a.result__a, a.result__url')).slice(0, 12).map(a => a.getAttribute('href'))`
      ).catch(() => []);
      const decoded = (Array.isArray(raw) ? raw : [])
        .filter(Boolean)
        .map(decodeDdgHref)
        .filter(u => /^https?:\/\//i.test(u));
      // Prefer official docs; keep original order otherwise. De-dupe by origin.
      const seen = new Set<string>();
      const ordered = [
        ...decoded.filter(u => DOC_HOST_RE.test(u)),
        ...decoded.filter(u => !DOC_HOST_RE.test(u)),
      ].filter(u => { const o = safeOrigin(u); if (seen.has(o)) return false; seen.add(o); return true; });
      links = ordered.slice(0, Math.max(1, maxPages));
    }

    if (links.length === 0) {
      // Fall back to the search page's own text so the model still gets signal.
      const text = String(await tab.evalJs(EXTRACT_TEXT_JS).catch(() => "")).slice(0, 4000);
      return { query: q, pages: [], note: `No followable result links were found; returning the search page text.\n\n${text}` };
    }

    const pages: SearchResult["pages"] = [];
    for (const url of links) {
      try {
        await tab.navigate(url);
        const title = String(await tab.evalJs("document.title").catch(() => "")).trim();
        const text = String(await tab.evalJs(EXTRACT_TEXT_JS).catch(() => "")).slice(0, 6000);
        if (text) pages.push({ title: title || url, url, text });
      } catch { /* skip a page that won't load; keep going */ }
    }

    if (pages.length === 0) return { query: q, pages: [], note: "Followed the top results but couldn't extract readable text from them." };
    return { query: q, pages };
  } finally {
    tab.close();
    await closeTab(target.id, port); // always close the throwaway automation tab
  }
}

function safeOrigin(u: string): string {
  try { return new URL(u).origin; } catch { return u; }
}
