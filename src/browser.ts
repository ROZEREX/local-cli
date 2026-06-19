import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";

// Browser control via the Chrome DevTools Protocol (CDP). We launch the user's
// installed Chrome/Edge/Chromium with --remote-debugging-port and drive it over a
// WebSocket — no Playwright, no npm, no browser download. Lets the agent open the
// apps it builds, navigate, read the page, click, and screenshot them.

const DEBUG_PORT = Number(process.env.LOCAL_CLI_CDP_PORT ?? 9222);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let child: ChildProcess | null = null;
let ws: WebSocket | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let consoleLogs: string[] = [];
// DevTools network capture: requests seen since the last navigation, keyed by
// CDP requestId, so the agent can inspect statuses/failures without screenshots.
interface NetReq { method: string; url: string; status?: number; type?: string; failed?: string; }
let networkLog = new Map<string, NetReq>();
// Live view: CDP screencast frames (base64 jpeg) are pushed to this callback so
// the web UI can show the page WHILE the agent works on it (cursor included —
// it's a DOM overlay, so it appears in the frames).
let screencastCb: ((b64: string) => void) | null = null;
let screencastOn = false;

// Locate an installed Chromium-family browser.
export function findBrowser(): string | null {
  if (platform() === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const px = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const la = process.env["LOCALAPPDATA"] || "";
    for (const c of [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${px}\\Google\\Chrome\\Application\\chrome.exe`,
      `${la}\\Google\\Chrome\\Application\\chrome.exe`,
      `${px}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]) if (c && existsSync(c)) return c;
  } else if (platform() === "darwin") {
    for (const c of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]) if (existsSync(c)) return c;
  } else {
    for (const x of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      try { const r = spawnSync("which", [x], { encoding: "utf-8" }); if (r.status === 0 && r.stdout.trim()) return r.stdout.trim(); } catch {}
    }
  }
  return null;
}

async function pageWsUrl(): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const targets = (await res.json()) as any[];
    const page = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? null;
  } catch { return null; }
}

function connect(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const to = setTimeout(() => reject(new Error("CDP connection timed out")), 5000);
    sock.onopen = () => { clearTimeout(to); ws = sock; resolve(); };
    sock.onerror = () => { clearTimeout(to); reject(new Error("CDP connection failed")); };
    sock.onclose = () => { if (ws === sock) { ws = null; screencastOn = false; } };
    sock.onmessage = (ev: any) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message || "CDP error")) : p.resolve(m.result);
      } else if (m.method === "Page.screencastFrame") {
        // Frames must be acked or the stream stalls. The reply to the ack is
        // ignored (no pending entry) — that's fine.
        try { sock.send(JSON.stringify({ id: ++msgId, method: "Page.screencastFrameAck", params: { sessionId: m.params?.sessionId } })); } catch {}
        if (m.params?.data && screencastCb) screencastCb(m.params.data);
      } else if (m.method === "Runtime.consoleAPICalled") {
        const type = m.params?.type || "log";
        const args = m.params?.args || [];
        const text = args.map((a: any) => a.value !== undefined ? String(a.value) : (a.description || "")).join(" ");
        consoleLogs.push(`[console.${type}] ${text}`);
      } else if (m.method === "Log.entryAdded") {
        const entry = m.params?.entry;
        if (entry) {
          consoleLogs.push(`[system.${entry.level || "log"}] ${entry.text || ""}`);
        }
      } else if (m.method === "Network.requestWillBeSent") {
        const p = m.params;
        if (p?.requestId && p.request?.url && !String(p.request.url).startsWith("data:")) {
          networkLog.set(p.requestId, { method: p.request.method || "GET", url: p.request.url, type: p.type });
          if (networkLog.size > 300) { const first = networkLog.keys().next().value; if (first) networkLog.delete(first); }
        }
      } else if (m.method === "Network.responseReceived") {
        const p = m.params;
        const req = p?.requestId ? networkLog.get(p.requestId) : undefined;
        if (req) { req.status = p.response?.status; req.type = p.type ?? req.type; }
      } else if (m.method === "Network.loadingFailed") {
        const p = m.params;
        const req = p?.requestId ? networkLog.get(p.requestId) : undefined;
        if (req) req.failed = p.errorText || "failed";
      }
    };
  });
}

// Connect to a running debug browser, or launch one. Returns a status note.
async function ensureBrowser(): Promise<void> {
  if (ws && ws.readyState === 1) return;
  let url = await pageWsUrl();
  if (!url) {
    const exe = findBrowser();
    if (!exe) throw new Error("No Chrome/Edge/Chromium found on this machine. Install Google Chrome to use browser control.");
    const dir = join(tmpdir(), "localcli-browser");
    child = spawn(exe, [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${dir}`,
      "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank",
    ], { detached: false, stdio: "ignore" });
    for (let i = 0; i < 40 && !url; i++) { await sleep(250); url = await pageWsUrl(); }
    if (!url) throw new Error("Launched the browser but its debugger never came up.");
  }
  await connect(url);
  await cdp("Page.enable").catch(() => {});
  await cdp("Runtime.enable").catch(() => {});
  await cdp("Log.enable").catch(() => {});
  await cdp("Network.enable").catch(() => {});
  await cdp("Performance.enable").catch(() => {});
}

function cdp(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("Browser is not connected"));
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 20000);
  });
}

export async function evalJs(expression: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluation error");
  return r?.result?.value;
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = await evalJs("document.readyState").catch(() => null);
    if (s === "complete" || s === "interactive") return;
    await sleep(150);
  }
}

export async function browserOpen(rawUrl: string): Promise<{ url: string; title: string }> {
  await ensureBrowser();
  consoleLogs = []; // Clear log buffer for new page navigation
  networkLog = new Map();
  const url = /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : "http://" + rawUrl;
  await cdp("Page.navigate", { url });
  await waitReady();
  await sleep(300);
  const title = (await evalJs("document.title").catch(() => "")) || "";
  return { url, title };
}

export async function browserReadText(): Promise<string> {
  await ensureBrowser();
  const text = (await evalJs("document.body ? document.body.innerText : ''")) || "";
  return String(text).slice(0, 8000);
}

// Read recent console errors/warnings/logs from the browser console captured via CDP.
export async function browserConsole(): Promise<string> {
  await ensureBrowser();
  return consoleLogs.join("\n");
}

// DevTools: the page's network requests since the last navigation — statuses,
// failures, and 4xx/5xx grouped first so problems are obvious.
export async function browserNetwork(): Promise<string> {
  await ensureBrowser();
  const reqs = [...networkLog.values()];
  if (reqs.length === 0) return "No network requests captured yet (open or reload a page first).";
  const bad = reqs.filter(r => r.failed || (r.status && r.status >= 400));
  const ok = reqs.filter(r => !r.failed && (!r.status || r.status < 400));
  const fmt = (r: NetReq) =>
    `  ${r.failed ? "✘ FAILED" : String(r.status ?? "…").padStart(3)}  ${r.method.padEnd(6)} ${r.url.length > 110 ? r.url.slice(0, 110) + "…" : r.url}${r.failed ? `  (${r.failed})` : ""}${r.type ? `  [${r.type}]` : ""}`;
  let out = `Network requests (${reqs.length} captured):\n`;
  if (bad.length) out += `\nProblems (${bad.length}):\n${bad.map(fmt).join("\n")}\n`;
  out += `\nAll requests:\n${ok.slice(-40).map(fmt).join("\n")}`;
  return out;
}

// DevTools: performance metrics — CDP counters + in-page navigation/paint timing.
export async function browserPerformance(): Promise<string> {
  await ensureBrowser();
  const lines: string[] = [];
  try {
    const m = await cdp("Performance.getMetrics");
    const get = (name: string) => (m?.metrics as any[])?.find(x => x.name === name)?.value;
    const mb = (b: number | undefined) => (b ? (b / 1048576).toFixed(1) + " MB" : "?");
    lines.push(`JS heap: ${mb(get("JSHeapUsedSize"))} used / ${mb(get("JSHeapTotalSize"))} total`);
    const nodes = get("Nodes"), docs = get("Documents"), listeners = get("JSEventListeners");
    if (nodes) lines.push(`DOM: ${nodes} nodes, ${docs ?? "?"} documents, ${listeners ?? "?"} event listeners`);
    const scriptDur = get("ScriptDuration"), layoutDur = get("LayoutDuration"), recalcDur = get("RecalcStyleDuration");
    if (scriptDur !== undefined) lines.push(`CPU time: script ${(scriptDur * 1000).toFixed(0)}ms, layout ${((layoutDur ?? 0) * 1000).toFixed(0)}ms, style ${((recalcDur ?? 0) * 1000).toFixed(0)}ms`);
  } catch { /* metrics unavailable */ }
  try {
    const timing = await evalJs(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find(p => p.name === 'first-contentful-paint');
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      return {
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav ? Math.round(nav.loadEventEnd) : null,
        ttfb: nav ? Math.round(nav.responseStart) : null,
        fcp: fcp ? Math.round(fcp.startTime) : null,
        lcp: lcpEntries.length ? Math.round(lcpEntries[lcpEntries.length-1].startTime) : null,
        resources: performance.getEntriesByType('resource').length,
        transferKB: Math.round(performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
      };
    })()`);
    if (timing) {
      const t = timing as any;
      lines.push(`Timing: TTFB ${t.ttfb ?? "?"}ms · FCP ${t.fcp ?? "?"}ms · LCP ${t.lcp ?? "?"}ms · DOMContentLoaded ${t.domContentLoaded ?? "?"}ms · load ${t.load ?? "?"}ms`);
      lines.push(`Resources: ${t.resources} loaded, ~${t.transferKB} KB transferred`);
    }
  } catch { /* timing unavailable */ }
  return lines.length ? `Page performance:\n  ${lines.join("\n  ")}` : "Couldn't read performance metrics from the page.";
}

// Shared in-page cursor helper. Defines window.__lcliCursor(el, label, color):
// a PERSISTENT animated AI pointer that glides to the element, shows a small
// action label ("click", "type"), and stays visible afterwards so a watching
// user (or the live screencast) always sees where the agent is.
const CURSOR_HELPER = `
  if (!window.__lcliCursor) {
    window.__lcliCursor = async function (el, label, color) {
      let c = document.getElementById('__lcli_cursor');
      if (!c) {
        c = document.createElement('div');
        c.id = '__lcli_cursor';
        c.style.cssText = 'position:fixed;z-index:2147483646;width:22px;height:22px;pointer-events:none;transition:left .45s cubic-bezier(.3,.7,.3,1),top .45s cubic-bezier(.3,.7,.3,1);left:50%;top:50%;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));';
        c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="#7aa2f7" stroke="#fff" stroke-width="1"><path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z"/></svg>'
          + '<div id="__lcli_cursor_label" style="position:absolute;left:18px;top:18px;display:none;background:#1a1b26;color:#c0caf5;border:1px solid #3b4261;border-radius:6px;padding:2px 7px;font:600 11px -apple-system,\\'Segoe UI\\',sans-serif;white-space:nowrap;"></div>';
        document.body.appendChild(c);
        await new Promise(r => setTimeout(r, 40));
      }
      const lab = document.getElementById('__lcli_cursor_label');
      if (lab) {
        clearTimeout(window.__lcliLabT);
        lab.textContent = label || '';
        lab.style.display = label ? 'block' : 'none';
        if (color) lab.style.borderColor = color;
        if (label) window.__lcliLabT = setTimeout(() => { lab.style.display = 'none'; }, 1800);
      }
      const r = el.getBoundingClientRect();
      c.style.left = (r.left + r.width / 2) + 'px';
      c.style.top = (r.top + r.height / 2) + 'px';
      await new Promise(r => setTimeout(r, 480));
    };
  }`;

// Click an element by CSS selector, or by visible text if no selector matches.
export async function browserClick(target: string): Promise<string> {
  await ensureBrowser();
  const js = `(async () => {
    ${CURSOR_HELPER}
    const t = ${JSON.stringify(target)};
    let el = null;
    try { el = document.querySelector(t); } catch {}
    if (!el) {
      const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary,[onclick]')];
      el = all.find(e => (e.innerText || e.value || '').trim().toLowerCase().includes(t.toLowerCase()));
    }
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({block:'center'});
    await window.__lcliCursor(el, 'click', '#7aa2f7');

    // Flash a highlight so the action is visible to a watching user.
    const prev = el.style.outline, prevOff = el.style.outlineOffset;
    el.style.outline = '3px solid #7aa2f7'; el.style.outlineOffset = '2px';

    el.click();

    await new Promise(r => setTimeout(r, 500));
    el.style.outline = prev; el.style.outlineOffset = prevOff;

    return 'CLICKED:' + (el.innerText || el.value || el.tagName).slice(0,60);
  })()`;
  const r = await evalJs(js);
  if (r === "NOT_FOUND") return `No element matched "${target}".`;
  return `Clicked ${String(r).replace("CLICKED:", "")}`;
}

// Type text into an element by CSS selector, or by visible text/placeholder/name if no selector matches.
export async function browserType(target: string, text: string): Promise<string> {
  await ensureBrowser();
  const js = `(async () => {
    ${CURSOR_HELPER}
    const t = ${JSON.stringify(target)};
    const txt = ${JSON.stringify(text)};
    let el = null;
    try { el = document.querySelector(t); } catch {}
    if (!el) {
      const all = [...document.querySelectorAll('input,textarea,[role=textbox]')];
      el = all.find(e => (e.placeholder || e.name || e.id || e.innerText || '').trim().toLowerCase().includes(t.toLowerCase()));
    }
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({block:'center'});
    await window.__lcliCursor(el, 'type', '#e0af68');

    // Flash a highlight so the action is visible to a watching user.
    const prev = el.style.outline, prevOff = el.style.outlineOffset;
    el.style.outline = '3px solid #e0af68'; el.style.outlineOffset = '2px';

    el.focus();
    el.value = txt;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise(r => setTimeout(r, 500));
    el.style.outline = prev; el.style.outlineOffset = prevOff;

    return 'TYPED:' + (el.placeholder || el.name || el.tagName).slice(0,60);
  })()`;
  const r = await evalJs(js);
  if (r === "NOT_FOUND") return `No element matched "${target}".`;
  return `Typed "${text}" into ${String(r).replace("TYPED:", "")}`;
}

// Scroll the page so the agent can reveal content before reading/screenshotting.
export async function browserScroll(to: string): Promise<string> {
  await ensureBrowser();
  const dir = ["up", "down", "top", "bottom"].includes(to) ? to : "down";
  const js = `(() => {
    const to = ${JSON.stringify(dir)};
    if (to === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (to === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    else window.scrollBy({ top: to === 'up' ? -600 : 600, behavior: 'smooth' });
    return Math.round(window.scrollY);
  })()`;
  await evalJs(js);
  await sleep(450); // let the smooth scroll settle so a follow-up read/shot sees the result
  return `Scrolled ${dir}.`;
}

// List the visible interactive elements (links, buttons, inputs) so the agent
// can SEE what it can click/type into — same idea as the extension's page_read.
export async function browserElements(): Promise<string> {
  await ensureBrowser();
  const js = `(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const label = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    return [...document.querySelectorAll('a,button,[role=button],input,select,textarea,summary,[onclick]')]
      .filter(vis).slice(0, 60)
      .map(el => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text: label(el), href: el.getAttribute('href') || '' }))
      .filter(e => e.text || e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select');
  })()`;
  const els = await evalJs(js).catch(() => []);
  if (!Array.isArray(els) || els.length === 0) return "";
  return els.map((e: any, i: number) => `  [${i}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.text}${e.href ? "  → " + e.href : ""}`).join("\n");
}

// ── live view (CDP screencast) ───────────────────────────────────────────────
// Stream jpeg frames of the page while the agent works, so the UI can show the
// browsing live (AI cursor included). Frames go to `cb`; call stop to end.
export async function browserStartScreencast(cb: (b64: string) => void): Promise<void> {
  if (!browserIsOpen()) throw new Error("No controlled browser is open.");
  screencastCb = cb;
  if (screencastOn) return;
  await cdp("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1100, maxHeight: 800, everyNthFrame: 2 });
  screencastOn = true;
}

export async function browserStopScreencast(): Promise<void> {
  screencastCb = null;
  if (!screencastOn) return;
  screencastOn = false;
  try { await cdp("Page.stopScreencast"); } catch {}
}

export function screencastActive(): boolean { return screencastOn; }


export async function browserScreenshot(): Promise<string> {
  await ensureBrowser();
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  return r.data as string; // base64 png
}

export async function browserClose(): Promise<void> {
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  ws = null; child = null; pending.clear();
  consoleLogs = [];
  networkLog = new Map();
  screencastCb = null; screencastOn = false;
}

export function browserIsOpen(): boolean { return !!ws && ws.readyState === 1; }
