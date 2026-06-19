// Injected into every page. Animates the AI cursor, flashes highlights, and
// executes commands from the agent (read / find / click / highlight / scroll).
// Relays responses back through the background worker.

if (!window.__localcliInjected) {
  window.__localcliInjected = true;

  const send = (payload) => chrome.runtime.sendMessage({ t: "to_server", payload });
  const reply = (id, result) => chrome.runtime.sendMessage({ t: "to_server", payload: { t: "cmdreply", id, result } });

  // ── visuals: AI cursor + highlight overlays ──────────────────────────────────
  let cursorEl = null, cursorLabelTimer = null;
  function aiCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.style.cssText = "position:fixed;z-index:2147483646;width:22px;height:22px;pointer-events:none;transition:left .5s cubic-bezier(.3,.7,.3,1),top .5s cubic-bezier(.3,.7,.3,1);left:50%;top:50%;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));";
    cursorEl.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="#7aa2f7" stroke="#fff" stroke-width="1"><path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z"/></svg>` +
      `<div class="lcli-cursor-lbl" style="position:absolute;left:18px;top:18px;display:none;background:#1a1b26;color:#c0caf5;border:1px solid #3b4261;border-radius:6px;padding:2px 7px;font:600 11px -apple-system,'Segoe UI',sans-serif;white-space:nowrap;"></div>`;
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }
  function moveCursorTo(el, label) {
    const r = el.getBoundingClientRect(); const c = aiCursor();
    const lbl = c.querySelector(".lcli-cursor-lbl");
    if (lbl) {
      clearTimeout(cursorLabelTimer);
      if (label) {
        lbl.textContent = label; lbl.style.display = "block";
        cursorLabelTimer = setTimeout(() => { lbl.style.display = "none"; }, 1800);
      } else lbl.style.display = "none";
    }
    c.style.left = (r.left + r.width / 2) + "px"; c.style.top = (r.top + r.height / 2) + "px";
  }
  function highlight(el, ms = 2500) {
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #7dcfff;border-radius:6px;background:#7dcfff22;box-shadow:0 0 0 4px #7dcfff22;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;transition:opacity .4s;`;
    document.documentElement.appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; setTimeout(() => box.remove(), 400); }, ms);
  }
  const clickable = "a,button,[role=button],input[type=submit],input[type=button],select,summary,[onclick]";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 80);

  function findEl(target) {
    try { const el = document.querySelector(target); if (el && visible(el)) return el; } catch {}
    const t = target.toLowerCase();
    const els = [...document.querySelectorAll(clickable)].filter(visible);
    return els.find(e => labelOf(e).toLowerCase().includes(t)) ||
      [...document.querySelectorAll("*")].filter(visible).find(e => e.childElementCount === 0 && (e.innerText || "").trim().toLowerCase().includes(t)) || null;
  }

  async function runCommand(m) {
    const { id, action, params } = m;
    try {
      if (action === "read") {
        const els = [...document.querySelectorAll(clickable)].filter(visible).slice(0, 60)
          .map(e => ({ tag: e.tagName.toLowerCase(), text: labelOf(e), href: e.getAttribute("href") || "" }))
          .filter(e => e.text);
        reply(id, { title: document.title, url: location.href, text: (document.body.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 6000), elements: els });
      } else if (action === "find") {
        const q = (params.query || "").toLowerCase();
        const matches = [...document.querySelectorAll("a,button,h1,h2,h3,li,p,span,div,td")].filter(visible)
          .filter(e => e.childElementCount === 0 && (e.innerText || "").toLowerCase().includes(q)).slice(0, 12);
        matches.forEach(e => highlight(e));
        if (matches[0]) matches[0].scrollIntoView({ block: "center", behavior: "smooth" });
        reply(id, { matches: matches.map(e => ({ tag: e.tagName.toLowerCase(), text: labelOf(e), href: e.getAttribute("href") || "" })) });
      } else if (action === "highlight") {
        const el = findEl(params.target);
        if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); highlight(el, 3500); }
        reply(id, { ok: !!el, count: el ? 1 : 0 });
      } else if (action === "click") {
        const el = findEl(params.target);
        if (!el) return reply(id, { ok: false });
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        moveCursorTo(el, "click"); highlight(el, 1500);
        await new Promise(r => setTimeout(r, 650));
        el.click();
        reply(id, { ok: true, label: labelOf(el) });
      } else if (action === "type") {
        const el = findEl(params.target);
        if (!el) return reply(id, { ok: false });
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        moveCursorTo(el, "type"); highlight(el, 1500);
        await new Promise(r => setTimeout(r, 650));
        el.focus();
        el.value = params.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        reply(id, { ok: true, label: labelOf(el) });
      } else if (action === "scroll") {
        const to = params.to || "down";
        if (to === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        else window.scrollBy({ top: to === "up" ? -600 : 600, behavior: "smooth" });
        reply(id, { ok: true });
      } else reply(id, { error: "unknown action" });
    } catch (e) { reply(id, { error: String(e && e.message || e) }); }
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.t === "cmd") runCommand(m);
  });

  // Announce tab presence to background script to enable action relays
  function register() { try { chrome.runtime.sendMessage({ t: "register" }); } catch {} }
  // Re-connect to background script keepalive port if connection shifts
  function keepalive() { try { const p = chrome.runtime.connect({ name: "keepalive" }); p.onDisconnect.addListener(() => setTimeout(keepalive, 1000)); } catch { setTimeout(keepalive, 2000); } }
  keepalive();
  register();
  setInterval(register, 3000);
}
