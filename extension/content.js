// Injected into every page. Renders a floating chat panel (in a shadow root so
// page CSS can't touch it), an animated "AI cursor", and highlight overlays, and
// executes the commands the agent sends (read / find / click / highlight / scroll)
// on THIS page — with visible feedback. Talks to the background worker, which
// relays to the local-cli server.

if (!window.__localcliInjected) {
  window.__localcliInjected = true;

  const send = (payload) => chrome.runtime.sendMessage({ t: "to_server", payload });
  const reply = (id, result) => chrome.runtime.sendMessage({ t: "to_server", payload: { t: "cmdreply", id, result } });

  // ── shadow-root UI ──────────────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "localcli-ext-host";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      .launch { position: fixed; right: 18px; bottom: 18px; width: 46px; height: 46px; border-radius: 50%;
        background: linear-gradient(135deg,#7dcfff,#7aa2f7); color:#0b0f1c; display:grid; place-items:center;
        font-size:20px; cursor:pointer; box-shadow:0 6px 20px #0008; z-index:5; user-select:none; }
      .panel { position: fixed; right: 18px; bottom: 18px; width: 360px; height: 520px; max-height: 80vh;
        background:#1a1b26; color:#c0caf5; border:1px solid #2a2e42; border-radius:16px; display:none;
        flex-direction:column; overflow:hidden; box-shadow:0 12px 40px #000a; z-index:6; }
      .panel.open { display:flex; }
      .hd { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid #2a2e42; cursor:move; }
      .hd .dot { width:8px; height:8px; border-radius:50%; background:#f7768e; }
      .hd .dot.on { background:#9ece6a; }
      .hd .ttl { font-weight:700; font-size:13px; background:linear-gradient(90deg,#7dcfff,#73daca); -webkit-background-clip:text; background-clip:text; color:transparent; }
      .hd .x { margin-left:auto; cursor:pointer; color:#565f89; font-size:18px; }
      .msgs { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; font-size:13px; }
      .m { line-height:1.45; white-space:pre-wrap; word-break:break-word; }
      .m.user { align-self:flex-end; background:#24283b; padding:7px 11px; border-radius:12px; max-width:85%; }
      .m.asst { color:#c0caf5; }
      .m.tool { color:#7dcfff; font-family:monospace; font-size:11px; opacity:.85; }
      .m.note { color:#e0af68; font-size:12px; }
      .think { color:#565f89; font-style:italic; font-size:12px; border-left:2px solid #2a2e42; padding-left:8px; }
      .cmp { display:flex; gap:6px; padding:10px; border-top:1px solid #2a2e42; }
      textarea { flex:1; resize:none; background:#1f2335; color:#c0caf5; border:1px solid #2a2e42; border-radius:10px; padding:8px 10px; font-size:13px; max-height:90px; }
      textarea:focus { outline:none; border-color:#7aa2f7; }
      .go { background:#7aa2f7; color:#0b0f1c; border:none; border-radius:10px; padding:0 14px; font-weight:700; cursor:pointer; }
      .hint { font-size:11px; color:#565f89; padding:0 10px 8px; }
    </style>
    <div class="launch" id="launch">◆</div>
    <div class="panel" id="panel">
      <div class="hd" id="hd"><span class="dot" id="dot"></span><span class="ttl">local-cli</span><span class="x" id="close">×</span></div>
      <div class="msgs" id="msgs"><div class="m note">Connecting to local-cli… make sure <b>bun run web</b> is running.</div></div>
      <div class="cmp"><textarea id="inp" rows="1" placeholder="Tell me what to do on this page…"></textarea><button class="go" id="go">▶</button></div>
      <div class="hint">e.g. “find the cheapest item” · the AI can read, highlight, and click here</div>
    </div>`;

  const $ = (s) => root.getElementById(s);
  const panel = $("panel"), msgs = $("msgs"), inp = $("inp"), dot = $("dot");
  let curAsst = null, busy = false;

  $("launch").onclick = () => { panel.classList.add("open"); $("launch").style.display = "none"; inp.focus(); };
  $("close").onclick = () => { panel.classList.remove("open"); $("launch").style.display = "grid"; };

  // draggable panel
  (() => { let dx = 0, dy = 0, drag = false; const hd = $("hd");
    hd.onmousedown = (e) => { drag = true; const r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; e.preventDefault(); };
    window.addEventListener("mousemove", (e) => { if (!drag) return; panel.style.left = (e.clientX - dx) + "px"; panel.style.top = (e.clientY - dy) + "px"; panel.style.right = "auto"; panel.style.bottom = "auto"; });
    window.addEventListener("mouseup", () => drag = false);
  })();

  function addMsg(cls, text) { const d = document.createElement("div"); d.className = "m " + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function stripThink(s) { return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, ""); }

  function onServer(m) {
    switch (m.t) {
      case "ready": dot.classList.add("on"); if (msgs.children.length === 1) msgs.innerHTML = ""; break;
      case "ext_status": dot.classList.toggle("on", m.connected); break;
      case "text": { if (!curAsst) curAsst = addMsg("asst", ""); curAsst._raw = (curAsst._raw || "") + m.v; curAsst.textContent = stripThink(curAsst._raw).trim(); msgs.scrollTop = msgs.scrollHeight; break; }
      case "tool_call": curAsst = null; addMsg("tool", "⚙ " + m.name + (m.summary ? " " + m.summary : "")); break;
      case "tool_result": break;
      case "notice": addMsg("note", m.v); break;
      case "error": addMsg("note", "⚠ " + m.v); break;
      case "turn_end": curAsst = null; busy = false; break;
      case "cmd": runCommand(m); break;
    }
  }
  chrome.runtime.onMessage.addListener((m) => {
    if (m.t === "toggle_panel") { const open = panel.classList.toggle("open"); $("launch").style.display = open ? "none" : "grid"; return; }
    onServer(m);
  });

  function submit() {
    const text = inp.value.trim(); if (!text || busy) return;
    addMsg("user", text); inp.value = ""; busy = true; curAsst = null;
    send({ t: "chat", text });
  }
  $("go").onclick = submit;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });

  // ── visuals: AI cursor + highlight overlays ──────────────────────────────────
  let cursorEl = null;
  function aiCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.style.cssText = "position:fixed;z-index:2147483646;width:22px;height:22px;pointer-events:none;transition:left .5s ease,top .5s ease;left:50%;top:50%;";
    cursorEl.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="#7aa2f7" stroke="#fff" stroke-width="1"><path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z"/></svg>`;
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }
  function moveCursorTo(el) {
    const r = el.getBoundingClientRect(); const c = aiCursor();
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
        moveCursorTo(el); highlight(el, 1500);
        await new Promise(r => setTimeout(r, 650));
        el.click();
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
}
