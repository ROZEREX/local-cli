import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";

export interface BrowserDriverOptions {
  remoteDebuggingPort?: number;
  chromePath?: string;
  userDataDir?: string;
  headless?: boolean;
}

/**
 * A standalone, zero-dependency browser driver that controls Chrome/Edge/Chromium
 * via the Chrome DevTools Protocol (CDP) using native WebSockets.
 * 
 * Features a gliding visual AI cursor overlay and outlining for click and type actions.
 */
export class BrowserDriver {
  private port: number;
  private chromePath: string | null;
  private userDataDir: string;
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private consoleLogs: string[] = [];

  constructor(options: BrowserDriverOptions = {}) {
    this.port = options.remoteDebuggingPort ?? 9222;
    this.chromePath = options.chromePath ?? this.findBrowser();
    this.userDataDir = options.userDataDir ?? join(tmpdir(), "browser-driver-session");
  }

  /**
   * Automatically auto-detects an installed Chrome/Edge/Chromium browser executable
   * across Windows, macOS, and Linux platforms.
   */
  public findBrowser(): string | null {
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
        try {
          const r = spawnSync("which", [x], { encoding: "utf-8" });
          if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
        } catch {}
      }
    }
    return null;
  }

  /**
   * Launch the browser (if not already running) and connect to the page debugger WebSocket.
   */
  public async launch(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;

    let url = await this.getPageWsUrl();
    if (!url) {
      if (!this.chromePath) {
        throw new Error("No Google Chrome, Microsoft Edge, or Chromium found. Please supply a custom path in the options.");
      }

      this.child = spawn(this.chromePath, [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        "about:blank",
      ], { detached: false, stdio: "ignore" });

      // Poll until the CDP server starts responding
      for (let i = 0; i < 40 && !url; i++) {
        await new Promise(r => setTimeout(r, 250));
        url = await this.getPageWsUrl();
      }

      if (!url) {
        throw new Error("Launched the browser, but the debugging WebSocket was never initialized.");
      }
    }

    await this.connectWs(url);
    await this.cdp("Page.enable").catch(() => {});
    await this.cdp("Runtime.enable").catch(() => {});
    await this.cdp("Log.enable").catch(() => {});
  }

  private async getPageWsUrl(): Promise<string | null> {
    try {
      const res = await fetch(`http://localhost:${this.port}/json`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const targets = (await res.json()) as any[];
      const page = targets.find((t: any) => t.type === "page" && t.webSocketDebuggerUrl);
      return page?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  private connectWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      const to = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 5000);

      sock.onopen = () => {
        clearTimeout(to);
        this.ws = sock;
        resolve();
      };
      sock.onerror = () => {
        clearTimeout(to);
        reject(new Error("CDP WebSocket connection failed"));
      };
      sock.onclose = () => {
        if (this.ws === sock) {
          this.ws = null;
        }
      };
      sock.onmessage = (ev: any) => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!;
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message || "CDP error")) : p.resolve(m.result);
        } else if (m.method === "Runtime.consoleAPICalled") {
          const type = m.params?.type || "log";
          const args = m.params?.args || [];
          const text = args.map((a: any) => a.value !== undefined ? String(a.value) : (a.description || "")).join(" ");
          this.consoleLogs.push(`[console.${type}] ${text}`);
        } else if (m.method === "Log.entryAdded") {
          const entry = m.params?.entry;
          if (entry) {
            this.consoleLogs.push(`[system.${entry.level || "log"}] ${entry.text || ""}`);
          }
        }
      };
    });
  }

  /**
   * Run a low-level Chrome DevTools Protocol command.
   */
  public cdp(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        return reject(new Error("Browser is not connected. Call .launch() first."));
      }
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} invocation timed out`));
        }
      }, 20000);
    });
  }

  /**
   * Evaluate a JavaScript expression inside the browser page context.
   */
  public async evalJs(expression: string): Promise<any> {
    const r = await this.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "JavaScript evaluation error");
    }
    return r?.result?.value;
  }

  /**
   * Navigate to a URL and wait for the page to be ready.
   */
  public async navigate(rawUrl: string): Promise<{ url: string; title: string }> {
    await this.launch();
    this.consoleLogs = []; // Clear previous logs
    const url = /^[a-z]+:/i.test(rawUrl) ? rawUrl : "http://" + rawUrl;
    await this.cdp("Page.navigate", { url });
    await this.waitReady();
    await new Promise(r => setTimeout(r, 300));
    const title = (await this.evalJs("document.title").catch(() => "")) || "";
    return { url, title };
  }

  private async waitReady(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const s = await this.evalJs("document.readyState").catch(() => null);
      if (s === "complete" || s === "interactive") return;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  /**
   * Read the visible text content of the page.
   */
  public async readText(): Promise<string> {
    await this.launch();
    const text = (await this.evalJs("document.body ? document.body.innerText : ''")) || "";
    return String(text).slice(0, 8000);
  }

  /**
   * Get console output logs from the active browser session.
   */
  public getConsoleLogs(): string[] {
    return [...this.consoleLogs];
  }

  /**
   * Helper that injects the visual gliding AI cursor helper script into the page DOM.
   */
  private getCursorHelperScript(): string {
    return `
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
  }

  /**
   * Click an element matching a CSS selector or visible text. Runs the mouse gliding animation first.
   */
  public async click(target: string): Promise<string> {
    await this.launch();
    const js = `(async () => {
      ${this.getCursorHelperScript()}
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

      const prev = el.style.outline, prevOff = el.style.outlineOffset;
      el.style.outline = '3px solid #7aa2f7'; el.style.outlineOffset = '2px';

      el.click();

      await new Promise(r => setTimeout(r, 500));
      el.style.outline = prev; el.style.outlineOffset = prevOff;

      return 'CLICKED:' + (el.innerText || el.value || el.tagName).slice(0,60);
    })()`;

    const r = await this.evalJs(js);
    if (r === "NOT_FOUND") return `No element matched "${target}".`;
    return `Clicked ${String(r).replace("CLICKED:", "")}`;
  }

  /**
   * Type text into an input or textarea element matching a CSS selector, name, or placeholder.
   */
  public async type(target: string, text: string): Promise<string> {
    await this.launch();
    const js = `(async () => {
      ${this.getCursorHelperScript()}
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

    const r = await this.evalJs(js);
    if (r === "NOT_FOUND") return `No element matched "${target}".`;
    return `Typed "${text}" into ${String(r).replace("TYPED:", "")}`;
  }

  /**
   * Scroll the viewport window up, down, or to the top or bottom of the page.
   */
  public async scroll(direction: "up" | "down" | "top" | "bottom"): Promise<string> {
    await this.launch();
    const js = `(() => {
      const to = ${JSON.stringify(direction)};
      if (to === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (to === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else window.scrollBy({ top: to === 'up' ? -600 : 600, behavior: 'smooth' });
      return Math.round(window.scrollY);
    })()`;
    await this.evalJs(js);
    await new Promise(r => setTimeout(r, 450)); // Wait for scrolling to settle
    return `Scrolled ${direction}.`;
  }

  /**
   * Get all visible interactive elements on the page (tags, types, texts, links).
   */
  public async elements(): Promise<string> {
    await this.launch();
    const js = `(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const label = el => (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      return [...document.querySelectorAll('a,button,[role=button],input,select,textarea,summary,[onclick]')]
        .filter(vis).slice(0, 60)
        .map(el => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text: label(el), href: el.getAttribute('href') || '' }))
        .filter(e => e.text || e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select');
    })()`;
    const els = await this.evalJs(js).catch(() => []);
    if (!Array.isArray(els) || els.length === 0) return "";
    return els.map((e: any, i: number) => `  [${i}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.text}${e.href ? "  → " + e.href : ""}`).join("\n");
  }

  /**
   * Capture a PNG screenshot of the current page as a base64 encoded string.
   */
  public async screenshot(): Promise<string> {
    await this.launch();
    const r = await this.cdp("Page.captureScreenshot", { format: "png" });
    return r.data as string;
  }

  /**
   * Close the page WebSocket and terminate the spawned Chrome process.
   */
  public async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {}
    try {
      this.child?.kill();
    } catch {}
    this.ws = null;
    this.child = null;
    this.pending.clear();
    this.consoleLogs = [];
  }

  /**
   * Verify if the browser is currently running and the WebSocket is active.
   */
  public isOpen(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }
}
