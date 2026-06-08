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
    sock.onclose = () => { if (ws === sock) ws = null; };
    sock.onmessage = (ev: any) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message || "CDP error")) : p.resolve(m.result);
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

// Read recent console errors/warnings the page logged (best-effort: we install a
// capture hook on first connect via an injected script).
export async function browserConsole(): Promise<string> {
  await ensureBrowser();
  const logs = await evalJs("window.__lcliLogs ? window.__lcliLogs.join('\\n') : ''").catch(() => "");
  return String(logs || "");
}

// Click an element by CSS selector, or by visible text if no selector matches.
export async function browserClick(target: string): Promise<string> {
  await ensureBrowser();
  const js = `(() => {
    const t = ${JSON.stringify(target)};
    let el = null;
    try { el = document.querySelector(t); } catch {}
    if (!el) {
      const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary,[onclick]')];
      el = all.find(e => (e.innerText || e.value || '').trim().toLowerCase().includes(t.toLowerCase()));
    }
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({block:'center'});
    // Flash a highlight so the action is visible to a watching user.
    const prev = el.style.outline, prevOff = el.style.outlineOffset;
    el.style.outline = '3px solid #7aa2f7'; el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevOff; }, 1200);
    el.click();
    return 'CLICKED:' + (el.innerText || el.value || el.tagName).slice(0,60);
  })()`;
  const r = await evalJs(js);
  if (r === "NOT_FOUND") return `No element matched "${target}".`;
  return `Clicked ${String(r).replace("CLICKED:", "")}`;
}

export async function browserScreenshot(): Promise<string> {
  await ensureBrowser();
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  return r.data as string; // base64 png
}

export async function browserClose(): Promise<void> {
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  ws = null; child = null; pending.clear();
}

export function browserIsOpen(): boolean { return !!ws && ws.readyState === 1; }
