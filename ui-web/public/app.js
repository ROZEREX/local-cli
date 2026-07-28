// Front end for local-cli's Web UI — full CLI parity in the browser.
// Talks to server.ts over a WebSocket (streamed agent loop) + REST endpoints
// for models / sessions / folders / profiles / servers.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Safe JSON fetch: returns fallback so wrong-version/stale server won't crash UI.
async function getJSON(url, fallback = null) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return fallback;
    return await r.json();
  } catch { return fallback; }
}

const messages = $("#messages");
const input = $("#input");
const liveEl = $("#live");
const icons = () => window.lucide?.createIcons();

let ws, cur = null, busy = false, pendingTools = [], awaiting = false;
let liveStart = 0, liveTimer = null, liveTokens = 0;
// Live phase: what the model is doing right now — "loading" (model into
// memory), "prefill" (reading the prompt), "thinking", "writing", "tool".
let livePhase = null, liveToolName = "", liveThinking = false;
let liveBadgeTimer = null, autoSwitched = false, liveViewOn = false;
let state = { model: "", cwd: "", contextWindow: 0, thinking: true, packageManager: "auto", activeProfile: null, profiles: [], availablePM: [] };
let mode = "normal";
let browserBusy = false;
let incognito = { on: false, since: null };
let backendWarning = "";

// ── markdown ──
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function md(src) {
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`); return `  ${blocks.length - 1}  `; });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of src.split("\n")) {
    const ph = raw.match(/^  (\d+)  $/);
    if (ph) { close(); html += blocks[+ph[1]]; continue; }
    let m;
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { close(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) { if (list !== "ul") { close(); list = "ul"; html += "<ul>"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) { if (list !== "ol") { close(); list = "ol"; html += "<ol>"; } html += `<li>${inline(m[1])}</li>`; }
    else if (raw.trim() === "") close();
    else { close(); html += `<p>${inline(raw)}</p>`; }
  }
  close();
  return html;
}

const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
const scroll = () => { messages.scrollTop = messages.scrollHeight; };
const relTime = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; };

// ── message bubbles ──
function bubble(role) {
  const wrap = document.createElement("div");
  wrap.className = "flex gap-3 animate-rise";
  
  const av = role === "user"
    ? `<div class="shrink-0 w-7 h-7 rounded-full grid place-items-center text-xs bg-zinc-900 border border-edge text-zinc-300 font-mono">❯</div>`
    : `<div class="shrink-0 w-7 h-7 rounded-full grid place-items-center text-xs bg-white text-black font-mono">◆</div>`;
    
  wrap.innerHTML = `${av}<div class="flex-1 min-w-0">
    <div class="text-[11px] text-dim mb-1 font-semibold tracking-wide">${role === "user" ? "you" : "assistant"}</div>
    <div class="think-container hidden">
      <div class="think-header flex items-center justify-between">
        <span class="flex items-center gap-1.5"><i data-lucide="brain" class="w-3 h-3 text-zinc-500"></i> Reasoning Process</span>
        <i data-lucide="chevron-down" class="w-3.5 h-3.5 transition-transform duration-200 tr-icon"></i>
      </div>
      <div class="think-block hidden"></div>
    </div>
    <div class="prose content"></div>
  </div>`;
  
  messages.appendChild(wrap);

  const thinkContainer = $(".think-container", wrap);
  const thinkHeader = $(".think-header", wrap);
  const thinkBlock = $(".think-block", wrap);
  
  thinkHeader.onclick = () => {
    const isHidden = thinkBlock.classList.toggle("hidden");
    const icon = $(".think-header i.tr-icon", wrap);
    if (icon) {
      icon.setAttribute("data-lucide", isHidden ? "chevron-down" : "chevron-up");
      icons();
    }
  };

  icons();
  return { wrap, thinkContainer, think: thinkBlock, content: $(".content", wrap), text: "", thought: "" };
}

function addUser(text, images) {
  const b = bubble("user");
  b.content.textContent = text;
  if (images && images.length) {
    const row = document.createElement("div");
    row.className = "flex flex-wrap gap-2 mt-2";
    row.innerHTML = images.map(im => `<img src="data:image/png;base64,${im}" class="max-h-40 rounded-xl border border-edge" />`).join("");
    b.content.appendChild(row);
  }
  scroll();
}
const ensureAssistant = () => (cur ||= bubble("assistant"));

function addText(v, think) {
  const stick = atBottom();
  const b = ensureAssistant();
  if (think) {
    b.thought += v;
    b.think.textContent = b.thought;
    b.thinkContainer.classList.remove("hidden");
  } else {
    b.text += v;
    b.content.innerHTML = md(b.text) + '<span class="caret"></span>';
  }
  if (stick) scroll();
}

function finishStreaming() { $$(".caret").forEach(c => c.remove()); cur = null; }

const TOOL_IC = { 
  read_file: "file-text", write_file: "file-plus", edit_file: "file-pen", 
  glob_files: "search", grep_files: "text-search", list_dir: "folder-open", 
  bash: "terminal", delete_file: "trash-2", run_server: "play", 
  server_logs: "scroll-text", stop_server: "square", list_servers: "list", 
  read_profile: "user-round", update_profile: "user-round-cog", ask_user: "circle-help", 
  list_ports: "plug-zap", kill_port: "power", browser_open: "globe", 
  browser_read: "book-open", browser_click: "mouse-pointer-click", browser_type: "keyboard",
  browser_screenshot: "image", browser_scroll: "chevrons-up-down", browser_close: "x-circle", screenshot: "monitor",
  page_open: "globe-2", page_navigate: "navigation", page_read: "book-open", 
  page_find: "search-code", page_click: "mouse-pointer-click", page_type: "keyboard",
  page_highlight: "highlighter", page_scroll: "chevrons-up-down",
  search_via_chrome: "globe", generate_image: "image-plus"
};

function addTool(name, summary) {
  finishStreaming();
  const stick = atBottom();
  const el = document.createElement("div");
  el.className = "rounded-2xl border border-edge border-l-[3px] border-l-zinc-500 bg-panel animate-pop overflow-hidden";
  el.innerHTML = `<div class="head flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-panel2 transition">
      <i data-lucide="${TOOL_IC[name] ?? "wrench"}" class="w-4 h-4 text-zinc-400 ic"></i>
      <span class="font-mono text-xs font-semibold text-white">${name}</span>
      <span class="font-mono text-[11px] text-dim flex-1 min-w-0 truncate ml-1">${esc(summary || "")}</span>
      <span class="state"><span class="spin"></span></span></div>
    <div class="body hidden px-3 pb-2.5"><pre class="m-0 bg-bg rounded-xl p-2.5 text-[11px] font-mono text-zinc-300 overflow-auto max-h-60 whitespace-pre-wrap border border-edge"></pre></div>`;
  messages.appendChild(el);
  $(".head", el).onclick = () => $(".body", el).classList.toggle("hidden");
  pendingTools.push({ name, el });
  icons();
  if (stick) scroll();
}

function fillTool(name, result) {
  const stick = atBottom();
  const i = pendingTools.findIndex(t => t.name === name);
  const t = i >= 0 ? pendingTools.splice(i, 1)[0] : null;
  if (!t) return;
  const err = /^Error|not found|denied|Exit [1-9]|timed out|NOT running/i.test(result);
  t.el.classList.remove("border-l-zinc-500");
  t.el.classList.add(err ? "border-l-danger" : "border-l-white");
  $(".ic", t.el).classList.remove("text-zinc-400");
  $(".ic", t.el).classList.add(err ? "text-danger" : "text-white");
  $(".state", t.el).innerHTML = err ? '<i data-lucide="x" class="w-4 h-4 text-danger"></i>' : '<i data-lucide="check" class="w-4 h-4 text-zinc-400"></i>';
  const pre = $(".body pre", t.el);
  pre.textContent = (result || "").split("\n").slice(0, 16).join("\n");
  $(".body", t.el).classList.remove("hidden");
  icons();
  if (stick) scroll();
}

function addNote(v, kind) {
  const d = document.createElement("div");
  const cls = kind === "error" ? "text-danger bg-red-950/20 border-red-900/30" : "text-dim bg-zinc-900/50 border-edge";
  d.className = `text-[12px] font-mono rounded-xl border px-3.5 py-2 animate-rise ${cls}`;
  d.textContent = v; messages.appendChild(d); scroll();
}

// A generated image, shown inline. Click to open it full size in a new tab.
function addImage(path, base64) {
  finishStreaming();
  const src = `data:image/png;base64,${base64}`;
  const d = document.createElement("div");
  d.className = "rounded-2xl border border-edge bg-panel overflow-hidden animate-rise max-w-lg";
  d.innerHTML = `<img src="${src}" alt="${esc(path)}" class="w-full h-auto block cursor-zoom-in" />
    <div class="px-3.5 py-2 text-[11px] font-mono text-dim border-t border-edge/60 truncate">${esc(path)}</div>`;
  d.querySelector("img").onclick = () => { const w = window.open(); if (w) w.document.write(`<img src="${src}" style="max-width:100%">`); };
  messages.appendChild(d); scroll();
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "px-3.5 py-1.5 rounded-full text-xs font-bold transition cursor-pointer " + cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function addAsk(m) {
  finishStreaming();
  const el = document.createElement("div");
  el.className = "rounded-2xl border border-zinc-600 bg-panel px-4 py-3.5 animate-pop space-y-3";
  awaiting = true; renderLive();
  const done = (label) => { awaiting = false; renderLive(); const o = el.querySelector(".opts"); if (o) o.innerHTML = `<span class="text-dim text-xs">→ ${esc(label)}</span>`; };
  if (m.t === "permission") {
    el.innerHTML = `<div class="flex items-center gap-2 text-xs font-semibold text-white"><i data-lucide="shield-alert" class="w-4 h-4 text-warn"></i><span><b class="font-mono">${esc(m.tool)}</b> requests permission:</span></div>
      <div class="font-mono text-[11px] text-zinc-300 bg-zinc-950 border border-edge rounded-xl px-3.5 py-2 mb-3 whitespace-pre-wrap">${esc(m.detail)}</div>
      <div class="opts flex gap-2"></div>`;
    const opts = el.querySelector(".opts");
    opts.append(
      mkBtn("Allow", "bg-white text-black hover:bg-zinc-200", () => { send({ t: "permission", id: m.id, approved: true }); done("Allowed"); }),
      mkBtn("Always allow " + m.tool, "border border-zinc-500 text-zinc-300 hover:text-white hover:bg-zinc-900", () => { send({ t: "permission", id: m.id, approved: true, always: true, tool: m.tool }); done("Always allowed"); }),
      mkBtn("Deny", "border border-edge text-zinc-400 hover:text-danger hover:border-danger hover:bg-zinc-950", () => { send({ t: "permission", id: m.id, approved: false }); done("Denied"); }),
    );
  } else {
    el.innerHTML = `<div class="flex items-center gap-2 text-xs font-semibold text-white"><i data-lucide="circle-help" class="w-4 h-4 text-accent"></i><span>${esc(m.question)}</span></div><div class="opts flex flex-wrap gap-2"></div>`;
    const opts = el.querySelector(".opts");
    m.options.forEach(o => opts.append(mkBtn(o, "border border-edge bg-zinc-900 text-zinc-300 hover:border-white hover:text-white", () => { send({ t: "choice", id: m.id, answer: o }); done(o); })));
  }
  messages.appendChild(el); icons(); scroll();
}

// ── live indicator ──
function startLive() { busy = true; liveTokens = 0; livePhase = null; liveToolName = ""; liveThinking = false; liveStart = Date.now(); $("#send").classList.add("hidden"); $("#stop").classList.remove("hidden"); liveEl.classList.remove("hidden"); liveEl.classList.add("flex"); liveTimer = setInterval(renderLive, 250); renderLive(); }
function renderLive() {
  const s = Math.floor((Date.now() - liveStart) / 1000);
  if (awaiting) { liveEl.innerHTML = `<span class="text-warn">⏸ awaiting your approval — click <b>Allow</b> or <b>Deny</b> above</span>`; return; }
  const tok = liveTokens ? ` · ↓${liveTokens.toLocaleString()} tok` : "";
  const tps = s > 0 && liveTokens ? Math.round(liveTokens / s) : 0;
  const speed = tps ? ` · ${tps} t/s` : "";
  if (livePhase === "loading") { liveEl.innerHTML = `<span class="spin"></span> loading the model into memory… · ${s}s <span class="text-dim/70">(cold start — can take a while, especially on first use)</span>`; return; }
  if (livePhase === "tool") { liveEl.innerHTML = `<span class="spin"></span> running <b class="text-white font-mono">${esc(liveToolName)}</b>… · ${s}s`; return; }
  if (livePhase === "prefill" && liveTokens === 0) { liveEl.innerHTML = `<span class="spin"></span> reading the prompt… · ${s}s <span class="text-dim/70">(prefill — the model is processing the conversation)</span>`; return; }
  if (liveTokens === 0) { liveEl.innerHTML = `<span class="spin"></span> waiting for the model… · ${s}s <span class="text-dim/70">(press Stop to cancel)</span>`; return; }
  if (liveThinking) { liveEl.innerHTML = `<span class="spin"></span> <span class="text-zinc-300">thinking</span>${tok} · ${s}s${speed}`; return; }
  liveEl.innerHTML = `<span class="spin"></span> writing${tok} · ${s}s${speed}`;
}
function stopLive() { busy = false; awaiting = false; livePhase = null; clearInterval(liveTimer); liveTimer = null; $("#send").classList.remove("hidden"); $("#stop").classList.add("hidden"); liveEl.classList.add("hidden"); liveEl.classList.remove("flex"); }

function setContext(used, limit) {
  $("#ctx-used").textContent = used.toLocaleString(); $("#ctx-limit").textContent = (limit || 0).toLocaleString();
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const p = $("#ctx-pct"); p.textContent = `(${pct}%)`; p.className = pct > 85 ? "text-danger" : pct > 65 ? "text-warn" : "text-dim";
}

// ── sessions ──
function renderSessions(list, active) {
  const box = $("#sessions"); box.innerHTML = "";
  if (incognito.on) {
    box.innerHTML = `<div class="mx-2 mt-2 px-3.5 py-3 rounded-2xl border border-incog/25 bg-incogdeep text-[11px] text-zinc-400 leading-relaxed">
      <div class="text-incog font-semibold mb-1">Chats hidden</div>
      This session isn't saved, and saved chats can't be opened while incognito is on.</div>`;
    return;
  }
  if (!list.length) { box.innerHTML = `<div class="text-dim text-xs px-4 py-4">No saved chats yet.</div>`; return; }
  for (const s of list) {
    const row = document.createElement("div");
    const on = s.id === active;
    row.className = `group px-3 py-2.5 mx-2 rounded-2xl cursor-pointer animate-slidein ${on ? "bg-panel border border-zinc-700 text-white" : "text-zinc-400 hover:bg-panel hover:text-white"}`;
    row.innerHTML = `<div class="flex items-center gap-2">
      <i data-lucide="message-square" class="w-3.5 h-3.5 ${on ? "text-white" : "text-dim"}"></i>
      <span class="text-xs truncate flex-1 font-mono">${esc(s.title)}</span>
      <button class="del opacity-0 group-hover:opacity-100 text-dim hover:text-danger transition-opacity"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button></div>
      <div class="text-[10px] text-dim mt-0.5 pl-5">${relTime(s.updatedAt)} · ${s.messageCount} msg · ${esc(s.model)}</div>`;
    row.onclick = (e) => { 
      if (e.target.closest(".del")) { 
        send({ t: "delete_session", id: s.id }); 
        e.stopPropagation(); 
        return; 
      } 
      messages.innerHTML = ""; 
      cur = null; 
      pendingTools = []; 
      send({ t: "load_session", id: s.id }); 
    };
    box.appendChild(row);
  }
  icons();
}

function renderLoaded(msgs) {
  messages.innerHTML = ""; cur = null; pendingTools = [];
  for (const m of msgs) {
    if (m.tool) { addNote(m.content, "info"); continue; }
    if (m.role === "user") addUser(m.content);
    else { const b = bubble("assistant"); b.text = m.content; b.content.innerHTML = md(m.content); }
  }
  scroll();
}

// ── controls reflect state ──
function applyConfig(c) {
  if (!c) return;
  state = { ...state, ...c };
  $("#cwd").textContent = c.cwd || "—"; $("#cwd").title = c.cwd || "";
  selectModel(c.model);
  $("#think-btn").classList.toggle("text-white", !!c.thinking);
  $("#think-btn").classList.toggle("border-zinc-400", !!c.thinking);
  const eb = $("#ext-badge"); if (eb) { eb.classList.toggle("hidden", !c.extConnected); eb.classList.toggle("flex", !!c.extConnected); }
  if (c.incognito) applyIncognito(c.incognito, c.backendWarning);
  
  // Refresh profiles if tab is open
  const actTab = localStorage.getItem("lcli-active-tab");
  if (actTab === "profiles") loadDashboardProfiles();
  
  // Update state browser tab header status
  const bStatus = $("#dash-b-status");
  if (bStatus) {
    bStatus.textContent = c.extConnected ? "Live Browser Extension" : "Controlled CDP Chrome";
    bStatus.className = `ml-auto text-[10px] px-2 py-0.5 rounded-full border ${c.extConnected ? "bg-grn/10 text-grn border-grn/30 font-bold" : "bg-zinc-950 text-white border-edge font-bold"}`;
  }
}
function setMode(m) { mode = m; $$("#mode .mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === m)); }

// ── possible-loop warning ──
// Deliberately NOT a stop. The detector fires on legitimate work (re-reading a
// file, re-running a test whose output hasn't changed yet), so the decision is
// the user's — we just make it visible and put Stop within one click.
function showLoopWarning(m) {
  const bar = $("#loop-warn");
  $("#loop-warn-text").textContent = m.willStop
    ? `${m.tool} repeated with identical results — stopping.`
    : `${m.tool} has repeated with the same result ${m.trips > 1 ? `(${m.trips} times) ` : ""}— it may be stuck, or it may just be working. Still running; nudged it to change approach.`;
  bar.classList.remove("hidden"); bar.classList.add("flex");
  icons();
}
function hideLoopWarning() { const b = $("#loop-warn"); b.classList.add("hidden"); b.classList.remove("flex"); }

// ── incognito ──
// The server owns the flag (it's process-wide), so this only ever REFLECTS what
// the server reported. Never flip the local state optimistically — the whole
// point of the mode is that the indicator can be trusted.
function applyIncognito(st, warning) {
  incognito = st || { on: false, since: null };
  if (typeof warning === "string") backendWarning = warning;
  const on = incognito.on;

  document.body.classList.toggle("incognito", on);
  $("#incog-bar").classList.toggle("hidden", !on);

  const btn = $("#incognito-btn");
  btn.classList.toggle("text-incog", on);
  btn.classList.toggle("border-incog", on);
  btn.classList.toggle("bg-incog/10", on);
  btn.classList.toggle("text-dim", !on);
  btn.classList.toggle("border-edge", !on);
  btn.title = on ? "Incognito is ON — click for details" : "Incognito — nothing written to disk, nothing sent off this machine";

  // The banner leads with the honest caveat rather than the reassurance.
  const sub = $("#incog-sub");
  if (on && backendWarning) {
    sub.textContent = backendWarning;
    sub.className = "text-[11px] text-warn";
  } else {
    sub.textContent = "No transcript, memory, profile or undo snapshot. Lookups run in a throwaway browser. File edits still change your disk, and /undo is off.";
    sub.className = "text-[11px] text-zinc-400 truncate";
  }
  icons();
}

const listHTML = (items, dotClass) => items.map(i => `
  <li class="flex gap-2.5">
    <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}"></span>
    <span><b class="text-white font-semibold">${esc(i.label)}</b><span class="text-zinc-400"> — ${esc(i.detail)}</span></span>
  </li>`).join("");

function incognitoInfoModal() {
  const sup = state.suppressed || [], np = state.notProtected || [];
  openModal(`Incognito${incognito.on ? " — on" : ""}`, `
    <div class="space-y-5 text-[12px] leading-relaxed">
      ${backendWarning ? `<div class="rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-warn">${esc(backendWarning)}</div>` : ""}
      <div>
        <h4 class="text-[11px] uppercase tracking-wider font-bold text-incog mb-2.5">What it stops</h4>
        <ul class="space-y-2">${listHTML(sup, "bg-incog")}</ul>
      </div>
      <div>
        <h4 class="text-[11px] uppercase tracking-wider font-bold text-warn mb-2.5">What it does NOT protect</h4>
        <ul class="space-y-2">${listHTML(np, "bg-warn")}</ul>
      </div>
      <p class="text-[11px] text-dim border-t border-edge pt-3.5">
        Turning incognito on or off clears the current conversation in every open tab — that's what keeps the two kinds of session from mixing.
        Chats saved <i>before</i> you switched it on are left alone; delete those yourself if you don't want them.
      </p>
    </div>`);
}

function toggleIncognito() {
  if (incognito.on) { send({ t: "set_incognito", on: false }); return; }
  const sup = state.suppressed || [];
  openModal("Turn on incognito?", `
    <div class="space-y-4 text-[12px] leading-relaxed">
      <p class="text-zinc-300">Nothing from this point on is written to disk by this app, and no tool may reach the network.</p>
      <ul class="space-y-2">${listHTML(sup, "bg-incog")}</ul>
      <div class="rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-warn">
        It is <b>not</b> a sandbox. Files the agent edits and commands it runs still change your machine — and with undo snapshots off, those edits can't be rolled back from here.
      </div>
      ${backendWarning ? `<div class="rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-warn">${esc(backendWarning)}</div>` : ""}
      <p class="text-dim text-[11px]">The current conversation will be cleared in every open tab.</p>
      <div class="flex gap-2 pt-1">
        <button id="incog-go" class="px-4 py-2 rounded-full bg-incog text-black font-bold text-xs hover:opacity-90 transition">Turn on incognito</button>
        <button id="incog-cancel" class="px-4 py-2 rounded-full border border-edge text-zinc-400 text-xs hover:text-white transition">Cancel</button>
      </div>
    </div>`);
  $("#incog-go").onclick = () => { send({ t: "set_incognito", on: true }); closeModal(); };
  $("#incog-cancel").onclick = closeModal;
}

// ── websocket ──
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $("#conn").className = "ml-auto w-2.5 h-2.5 rounded-full bg-grn border border-black";
  ws.onclose = () => { $("#conn").className = "ml-auto w-2.5 h-2.5 rounded-full bg-danger border border-black"; stopLive(); setTimeout(connect, 1200); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case "ready":
        if (!m.config) { addNote("This page is talking to an OLD server. Fully stop the running `bun run web` (close its terminal / kill the process on port 4317) and start it again, then refresh.", "error"); break; }
        applyConfig(m.config); setContext(0, m.config.contextWindow); 
        send({ t: "servers" });
        send({ t: "ports" });
        break;
      case "config": applyConfig(m.config); break;
      case "user": addUser(m.text, m.images); cur = null; break;
      case "text": if (!busy) startLive(); livePhase = "generating"; liveThinking = !!m.think; addText(m.v, m.think); break;
      case "tool_call": if (!busy) startLive(); livePhase = "tool"; liveToolName = m.name; setBrowserAction(m.name, m.summary); addTool(m.name, m.summary); break;
      case "tool_result": livePhase = null; setBrowserAction(null); fillTool(m.name, m.result); break;
      case "status": livePhase = m.phase === "generating" ? "generating" : m.phase; renderLive(); break;
      case "progress": liveTokens = m.tok; break;
      case "notice": addNote(m.v, "info"); break;
      case "error": addNote(m.v, "error"); break;
      case "permission": addAsk(m); break;
      case "choice": addAsk(m); break;
      case "context": setContext(m.used, m.limit); break;
      case "mode": setMode(m.mode); break;
      case "loop_warning": showLoopWarning(m); break;
      case "image": addImage(m.path, m.data); break;
      case "incognito": {
        // The server also sends this on connect to sync a tab that joined an
        // already-incognito process — announce a real CHANGE, not the handshake.
        const changed = incognito.on !== !!m.state.on;
        applyIncognito(m.state, m.backendWarning);
        if (changed) {
          addNote(m.state.on
            ? "Incognito on — this conversation is not being saved. Lookups go through a throwaway browser, so nothing lands in your Chrome history (but a search engine still sees the query — never ask it to look up a secret). File edits still change your disk and can't be undone from here."
            : "Incognito off — chats are saved again. Nothing from the incognito session was written, and settings you changed during it were discarded.", "info");
        } else if (m.state.on) {
          addNote("Incognito is on — this conversation is not being saved.", "info");
        }
        break;
      }
      case "sessions": renderSessions(m.list, m.active); break;
      case "load": renderLoaded(m.messages); break;
      case "servers": renderDashboardServers(m.list); break;
      case "ports": renderDashboardPorts(m.list); break;
      case "browser_state": browserBusy = false; renderBrowserState(m); break;
      case "browser_frame": renderBrowserFrame(m.data); break;
      case "browser_live": liveViewOn = !!m.on; $("#dash-b-live-btn").classList.toggle("text-grn", liveViewOn); break;
      case "cleared": messages.innerHTML = ""; cur = null; pendingTools = []; break;
      case "turn_end": finishStreaming(); stopLive(); setBrowserAction(null); hideLoopWarning(); autoSwitched = false; if (m.mode === "plan") showPlanApprove(); break;
    }
  };
}

function showPlanApprove() {
  const el = document.createElement("div");
  el.className = "rounded-full border border-zinc-600 bg-panel pl-5 pr-2 py-2 animate-pop flex items-center gap-3 max-w-lg mx-auto";
  el.innerHTML = `<i data-lucide="clipboard-check" class="w-4 h-4 text-white"></i><span class="text-xs font-bold flex-1">Plan ready. Approve to build it.</span>
    <button class="px-3.5 py-1.5 rounded-full bg-white text-black font-bold text-xs hover:bg-zinc-200 transition">Approve & build</button>`;
  $("button", el).onclick = () => { setMode("normal"); send({ t: "set_mode", mode: "normal" }); el.remove(); submitText("Approve the plan and implement it now."); };
  messages.appendChild(el); icons(); scroll();
}

// ── modal helper ──
const modal = $("#modal"), modalCard = $("#modal-card");
function openModal(title, bodyHTML) {
  modalCard.innerHTML = `<div class="flex items-center gap-2 px-4 py-3 border-b border-edge/60">
    <span class="font-semibold text-sm flex-1 text-white">${title}</span>
    <button id="modal-x" class="text-dim hover:text-white transition"><i data-lucide="x" class="w-4 h-4"></i></button></div>
    <div class="overflow-y-auto p-4">${bodyHTML}</div>`;
  modal.classList.remove("hidden"); icons();
  $("#modal-x").onclick = closeModal;
  return modalCard;
}
function closeModal() { modal.classList.add("hidden"); }
modal.onclick = (e) => { if (e.target === modal) closeModal(); };

// ── models ──
async function loadModels() {
  try {
    const list = await (await fetch("/api/models")).json();
    const sel = $("#model"); sel.innerHTML = "";
    for (const m of list) { 
      const o = document.createElement("option"); 
      o.value = m.name; 
      const spec = [m.parameterSize, m.quantization].filter(Boolean).join(" · "); 
      o.textContent = spec ? `${m.name}  (${spec})` : m.name; 
      sel.appendChild(o); 
    }
    sel.onchange = () => send({ t: "set_model", model: sel.value });
    selectModel(state.model);
  } catch {}
}
const selectModel = (model) => { const sel = $("#model"); if (sel && model && [...sel.options].some(o => o.value === model)) sel.value = model; };

async function modelInfoModal() {
  const c = openModal("Model details", `<div class="text-dim text-sm">Loading…</div>`);
  const info = (await getJSON(`/api/modelinfo?name=${encodeURIComponent(state.model)}`)) || {};
  const rows = [["Model", info.name || state.model], ["Parameters", info.parameterSize], ["Quantization", info.quantization], ["Family", info.family], ["Native context", info.contextLength ? info.contextLength.toLocaleString() + " tokens" : null], ["Capabilities", (info.capabilities || []).join(", ")]];
  $(".overflow-y-auto", c).innerHTML = `<div class="space-y-2.5">${rows.filter(r => r[1]).map(r => `<div class="flex gap-3 text-xs"><span class="text-dim w-32 shrink-0 font-medium">${r[0]}</span><span class="font-mono text-white">${esc(String(r[1]))}</span></div>`).join("")}</div>`;
}

// ── folder browser ──
async function browse(path, { multi = false, onPick } = {}) {
  const data = await getJSON(`/api/dir?path=${encodeURIComponent(path)}`);
  if (!data) { $(".overflow-y-auto", modalCard).innerHTML = `<div class="text-danger text-sm">Couldn't list that folder. Make sure the web server is up to date (restart <span class="font-mono">bun run web</span>).</div>`; return; }
  const c = modalCard;
  $(".overflow-y-auto", c).innerHTML = `
    <div class="font-mono text-[11px] text-dim mb-3 break-all">${esc(data.dir)}</div>
    <div class="space-y-0.5 max-h-[46vh] overflow-y-auto border border-edge bg-zinc-950 rounded-2xl p-1.5">${data.entries.map((e, i) => `
      <div data-i="${i}" data-dir="${e.isDir}" data-name="${esc(e.name)}" class="entry flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-zinc-900 cursor-pointer transition">
        ${multi && !e.isDir ? `<input type="checkbox" class="chk accent-white" />` : `<span class="w-3.5"></span>`}
        <i data-lucide="${e.isDir ? "folder" : "file"}" class="w-4 h-4 ${e.isDir ? "text-white" : "text-dim"}"></i>
        <span class="text-xs font-mono ${e.name === ".." ? "text-dim" : "text-zinc-350"}">${esc(e.name)}</span></div>`).join("")}</div>
    <div class="flex gap-2 mt-4 pt-3 border-t border-edge/60">
      ${multi ? `<button id="attach-go" class="px-4 py-2 rounded-full bg-white text-black font-bold text-xs hover:bg-zinc-200 transition">Attach selected</button>` : `<button id="use-dir" class="px-4 py-2 rounded-full bg-white text-black font-bold text-xs hover:bg-zinc-200 transition">Use this folder</button>`}
      <button id="browse-close" class="px-4 py-2 rounded-full border border-edge text-xs text-dim hover:text-white transition">Cancel</button></div>`;
  icons();
  c.__dir = data.dir;
  $$(".entry", c).forEach(row => {
    row.onclick = (e) => {
      if (e.target.classList.contains("chk")) return;
      const name = row.dataset.name, isDir = row.dataset.dir === "true";
      if (isDir) { const next = name === ".." ? data.dir.replace(/[\\/][^\\/]+[\\/]?$/, "") : data.dir.replace(/[\\/]?$/, "/") + name; browse(next, { multi, onPick }); }
      else if (multi) { const chk = $(".chk", row); chk.checked = !chk.checked; }
    };
  });
  $("#browse-close").onclick = closeModal;
  if (multi) $("#attach-go").onclick = () => { const sel = $$(".entry", c).filter(r => $(".chk", r)?.checked).map(r => c.__dir.replace(/[\\/]?$/, "/") + r.dataset.name); if (sel.length) { send({ t: "add_files", paths: sel }); closeModal(); } };
  else $("#use-dir").onclick = () => onPick(c.__dir);
}
function folderModal() { openModal("Working folder", `<div class="text-dim text-sm">Loading…</div>`); browse(state.cwd, { onPick: (dir) => { send({ t: "set_cwd", path: dir }); closeModal(); } }); }
function attachModal() { openModal("Attach files to context", `<div class="text-dim text-sm">Loading…</div>`); browse(state.cwd, { multi: true }); }

// ── Dashboard views rendering ──

// Runtime view
function renderDashboardServers(list) {
  const box = $("#dash-servers-list");
  if (!list.length) {
    box.innerHTML = `<div class="text-dim text-xs py-2.5 bg-zinc-950 px-3.5 rounded-xl border border-edge">No background dev servers running.</div>`;
    return;
  }
  box.innerHTML = list.map(s => {
    const isRun = s.status === "running";
    return `
      <div class="srv-card rounded-2xl border border-edge bg-panel p-3.5 space-y-2">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${isRun ? "bg-grn" : "bg-dim"}"></span>
          <span class="font-mono text-xs text-white font-bold flex-1 truncate">${esc(s.command)}</span>
          <button data-srv-act="logs" data-id="${s.id}" class="text-[10px] font-bold uppercase px-2 py-1 rounded-full border border-edge hover:bg-zinc-800 transition">logs</button>
          ${isRun ? `<button data-srv-act="stop" data-id="${s.id}" class="text-[10px] font-bold uppercase px-2 py-1 rounded-full border border-edge hover:bg-zinc-800 text-danger hover:border-danger transition">stop</button>` : ""}
        </div>
        ${s.url ? `<div class="text-xs"><a href="${s.url}" target="_blank" class="text-white underline font-mono font-semibold">${s.url}</a></div>` : ""}
        <div class="srv-logs-box hidden mt-2"><pre class="bg-zinc-950 rounded-xl p-2.5 text-[10px] font-mono text-zinc-300 max-h-48 overflow-auto whitespace-pre-wrap border border-edge"></pre></div>
      </div>`;
  }).join("");
  icons();

  $$("[data-srv-act]", box).forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.srvAct === "stop") {
      send({ t: "stop_server", id });
      setTimeout(() => send({ t: "servers" }), 500);
    } else {
      const row = b.closest(".srv-card");
      const logsBox = row.querySelector(".srv-logs-box");
      const logsPre = logsBox.querySelector("pre");
      const isHidden = logsBox.classList.toggle("hidden");
      if (!isHidden) {
        logsPre.textContent = "Loading logs…";
        const d = (await getJSON(`/api/serverlogs?id=${id}`)) || {};
        logsPre.textContent = (d.lines || []).join("\n") || "(no output)";
      }
    }
  });
}

function renderDashboardPorts(list) {
  const box = $("#dash-ports-list");
  if (!list || !list.length) {
    box.innerHTML = `<div class="text-dim text-xs py-2.5 bg-zinc-950 px-3.5 rounded-xl border border-edge">No active listening ports.</div>`;
    return;
  }
  box.innerHTML = `<div class="space-y-1">${list.map(p => `
    <div class="flex items-center gap-3 rounded-full border border-edge bg-panel px-4 py-2">
      <span class="font-mono text-white text-xs font-bold w-12 shrink-0">:${p.port}</span>
      <span class="font-mono text-[11px] text-dim flex-1 truncate">pid ${p.pid}${p.process ? " · " + esc(p.process) : ""}</span>
      <button data-port="${p.port}" class="kill-port-btn text-[10px] font-bold uppercase px-2 py-1 rounded-full border border-edge hover:bg-zinc-800 text-danger hover:border-danger transition flex items-center gap-1"><i data-lucide="power" class="w-3 h-3"></i> kill</button>
    </div>`).join("")}</div>`;
  icons();
  $$(".kill-port-btn", box).forEach(b => b.onclick = () => {
    if (confirm(`Kill the process on port ${b.dataset.port}?`)) {
      send({ t: "kill_port", port: Number(b.dataset.port) });
      setTimeout(() => send({ t: "ports" }), 500);
    }
  });
}

// Profiles view
async function loadDashboardProfiles() {
  const box = $("#dash-profiles-list");
  box.innerHTML = `<div class="text-dim text-xs py-2"><span class="spin"></span> Loading profiles…</div>`;
  const data = (await getJSON("/api/profiles")) || { names: [], active: null };
  if (!data.names.length) {
    box.innerHTML = `<div class="text-dim text-xs py-2 bg-zinc-950 px-3.5 rounded-xl border border-edge">No custom coding profiles created.</div>`;
    return;
  }
  box.innerHTML = `<div class="space-y-1.5">${data.names.map(n => {
    const active = n === data.active;
    return `
      <div class="flex items-center gap-2 p-2.5 rounded-2xl border border-edge bg-panel hover:bg-panel2 transition">
        <i data-lucide="user-round" class="w-4 h-4 ${active ? "text-white" : "text-dim"}"></i>
        <span class="text-xs font-mono flex-1 truncate ${active ? "text-white font-bold" : "text-zinc-400"}">${esc(n)}</span>
        <div class="flex items-center gap-1 shrink-0">
          <button data-act="use" data-n="${esc(n)}" class="text-[10px] uppercase font-bold px-2 py-1 rounded-full border border-edge hover:bg-zinc-800 transition">use</button>
          <button data-act="view" data-n="${esc(n)}" class="text-[10px] uppercase font-bold px-2 py-1 rounded-full border border-edge hover:bg-zinc-800 transition">view</button>
          <button data-act="del" data-n="${esc(n)}" class="text-dim hover:text-danger p-1"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        </div>
      </div>`;
  }).join("")}</div>`;
  icons();
  
  $$("[data-act]", box).forEach(b => b.onclick = async () => {
    const n = b.dataset.n;
    if (b.dataset.act === "use") {
      send({ t: "set_profile", name: n });
      setTimeout(loadDashboardProfiles, 300);
    } else if (b.dataset.act === "del") {
      if (confirm(`Delete profile "${n}"?`)) {
        send({ t: "del_profile", name: n });
        setTimeout(loadDashboardProfiles, 300);
      }
    } else {
      const p = (await getJSON(`/api/profile?name=${encodeURIComponent(n)}`)) || {};
      openModal(`Profile · ${n}`, `<pre class="whitespace-pre-wrap text-xs text-ink/90 font-mono bg-zinc-950 p-4 border border-edge rounded-2xl max-h-[60vh] overflow-y-auto">${esc(p.content || "(empty)")}</pre>`);
    }
  });
}

// Loaded models (Ollama /api/ps) with the GPU/RAM split — makes VRAM spill
// visible instead of a silent slowdown.
function loadedModelsHTML(list) {
  if (!Array.isArray(list) || !list.length) {
    return `<div class="text-dim text-xs py-2 bg-zinc-950 px-3.5 rounded-xl border border-edge">Nothing loaded in Ollama right now (models load on first message).</div>`;
  }
  const gb = (n) => (n / 1e9).toFixed(1);
  return list.map(m => {
    const hasSplit = m.size > 0 && typeof m.sizeVram === "number";
    const pct = hasSplit ? Math.min(100, Math.round((m.sizeVram / m.size) * 100)) : null;
    const spilled = pct !== null && pct < 100;
    return `
      <div class="rounded-2xl border border-edge bg-panel p-3.5 space-y-1.5">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-white font-bold flex-1 truncate">${esc(m.name)}</span>
          <span class="text-[10px] font-mono ${spilled ? "text-warn" : "text-grn"}">${pct === null ? "" : spilled ? `${pct}% GPU ⚠` : "100% GPU"}</span>
        </div>
        ${hasSplit ? `
        <div class="h-1.5 rounded-full bg-zinc-800 overflow-hidden flex">
          <div class="h-full ${spilled ? "bg-warn" : "bg-grn"}" style="width:${pct}%"></div>
        </div>
        <div class="text-[10px] font-mono text-dim">${gb(m.sizeVram)} GB VRAM${spilled ? ` + ${gb(m.size - m.sizeVram)} GB system RAM` : ""} · ${gb(m.size)} GB total</div>
        ${spilled ? `<div class="text-[10px] text-warn">Partially in RAM — generation is slower. Lower the context window, use a smaller quant, or a smaller model.</div>` : ""}` : ""}
      </div>`;
  }).join("");
}

// System view
async function loadDashboardSystem() {
  const box = $("#dash-system-content");
  box.innerHTML = `<div class="text-dim text-xs py-2"><span class="spin"></span> Querying hardware…</div>`;
  const [d, loaded] = await Promise.all([getJSON("/api/system"), getJSON("/api/loaded", [])]);
  if (!d) {
    box.innerHTML = `<div class="text-danger text-xs py-2">Failed to load system specifications.</div>`;
    return;
  }
  const i = d.info;
  const row = (k, v) => `<div class="flex gap-2 text-xs py-1"><span class="text-dim w-24 shrink-0 font-bold uppercase tracking-wider text-[10px]">${k}</span><span class="font-mono text-zinc-350 break-all">${esc(v)}</span></div>`;
  const gpus = i.gpus.length ? i.gpus.map(g => `${g.name}${g.vramGB ? ` (${g.vramGB} GB VRAM)` : ""}`).join(", ") : "none detected (CPU inference)";
  const recCard = (r) => `
    <div class="rounded-2xl border border-edge bg-panel p-3.5 space-y-1.5">
      <div class="text-[11px] font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
        <i data-lucide="${r.task === 'coding' ? 'code' : r.task === 'vision' ? 'eye' : 'sparkles'}" class="w-3.5 h-3.5"></i>${r.task}
      </div>
      <div class="space-y-1">${r.options.map(o => `
        <div class="flex items-center gap-2 text-[11px] font-mono ${o.fits ? "" : "opacity-45"}">
          <span class="${o.fits ? "text-grn" : "text-dim"}">${o.fits ? "✓" : "○"}</span>
          <span class="${o.name === r.best ? "text-white font-bold" : ""}">${esc(o.name)}</span>
          ${o.note ? `<span class="text-dim font-sans">— ${esc(o.note)}</span>` : ""}
        </div>`).join("")}
      </div>
    </div>`;
  
  box.innerHTML = `
    <div class="space-y-1 bg-zinc-950 p-3.5 rounded-2xl border border-edge mb-4">
      ${row("OS", i.os)}
      ${row("CPU", `${i.cpu.model} (${i.cpu.cores} cores)`)}
      ${row("RAM", `${i.ramGB} GB (${i.ramFreeGB} free)`)}
      ${row("GPU", gpus)}
      ${row("Model budget", `~${i.budgetGB} GB (${i.budgetSource === "gpu" ? "GPU VRAM" : "system RAM, CPU"})`)}
    </div>
    <div class="text-[10px] uppercase tracking-wider text-dim font-bold mb-2">Loaded Now (VRAM / RAM)</div>
    <div class="grid gap-2 mb-4">${loadedModelsHTML(loaded)}</div>
    <div class="text-[10px] uppercase tracking-wider text-dim font-bold mb-2">GPU &amp; Speed Tuning</div>
    <div class="rounded-2xl border border-edge bg-panel p-3.5 space-y-2 mb-4 text-[11px]">
      <div class="space-y-1 font-mono">
        <div class="flex gap-2"><span class="text-dim w-32 shrink-0">contextWindow</span><span class="text-white">${(state.contextWindow || 0).toLocaleString()}</span><span class="text-dim">(KV cache grows with this — biggest VRAM lever)</span></div>
        <div class="flex gap-2"><span class="text-dim w-32 shrink-0">keepAlive</span><span class="text-white">${esc(String(state.keepAlive ?? "30m"))}</span><span class="text-dim">(model stays loaded between turns)</span></div>
        <div class="flex gap-2"><span class="text-dim w-32 shrink-0">numGpu</span><span class="text-white">${state.numGpu ?? "auto"}</span><span class="text-dim">(GPU layers; auto = Ollama decides)</span></div>
        <div class="flex gap-2"><span class="text-dim w-32 shrink-0">numThread</span><span class="text-white">${state.numThread ?? "auto"}</span><span class="text-dim">(CPU threads for the non-GPU part)</span></div>
      </div>
      <div class="border-t border-edge/60 pt-2 text-dim leading-relaxed">
        To squeeze the most out of the GPU, set these <b class="text-zinc-300">Ollama server</b> environment variables (then restart Ollama):
        <pre class="bg-zinc-950 border border-edge rounded-xl p-2.5 mt-1.5 text-[10px] text-zinc-300 whitespace-pre-wrap">OLLAMA_FLASH_ATTENTION=1      # faster attention, less VRAM
OLLAMA_KV_CACHE_TYPE=q8_0     # halves KV-cache VRAM, ~no quality loss
OLLAMA_NUM_PARALLEL=1         # one request slot = one KV cache
OLLAMA_MAX_LOADED_MODELS=1    # don't keep two models fighting for VRAM</pre>
        If "Loaded Now" above shows a model split between GPU and RAM: lower the context window, use a smaller quant (q4_K_M), or a smaller model — that split is what makes generation crawl.
      </div>
    </div>
    <div class="text-[10px] uppercase tracking-wider text-dim font-bold mb-2">Recommended Models (Ollama)</div>
    <div class="grid gap-2">${d.recommendations.map(recCard).join("")}</div>`;
  icons();
}

// What the agent is doing in the browser right now (ribbon above the viewport).
const BROWSER_VERB = {
  browser_open: "opening", page_open: "opening", page_navigate: "navigating to",
  browser_click: "clicking", page_click: "clicking",
  browser_type: "typing into", page_type: "typing into",
  browser_read: "reading the page", page_read: "reading the page",
  browser_scroll: "scrolling", page_scroll: "scrolling",
  browser_screenshot: "looking at the page", page_find: "finding", page_highlight: "highlighting",
};
function setBrowserAction(name, summary) {
  const box = $("#dash-b-action");
  if (!box) return;
  if (!name || !BROWSER_VERB[name]) { box.classList.add("hidden"); box.classList.remove("flex"); return; }
  $("#dash-b-action-text").textContent = `${BROWSER_VERB[name]}${summary ? " " + summary : ""}…`;
  box.classList.remove("hidden"); box.classList.add("flex");
  switchToBrowserTab();
}

// Live screencast frame from the controlled browser — the user watches the AI
// cursor work in real time. The LIVE badge hides shortly after frames stop.
function renderBrowserFrame(data) {
  const img = $("#dash-b-viewport-img");
  img.src = `data:image/jpeg;base64,${data}`;
  img.classList.remove("hidden");
  $("#dash-b-viewport-empty").classList.add("hidden");
  const badge = $("#dash-b-live");
  badge.classList.remove("hidden"); badge.classList.add("flex");
  clearTimeout(liveBadgeTimer);
  liveBadgeTimer = setTimeout(() => { badge.classList.add("hidden"); badge.classList.remove("flex"); }, 1600);
  switchToBrowserTab();
}

// Bring the Browser tab forward once per turn when browser activity starts, so
// the user actually sees the agent working (without fighting their tab choice).
function switchToBrowserTab() {
  if (autoSwitched || $("#dashboard").classList.contains("hidden")) return;
  autoSwitched = true;
  if (localStorage.getItem("lcli-active-tab") !== "browser") setTab("browser");
}

// Browser View State rendering
function renderBrowserState(m) {
  const viewportImg = $("#dash-b-viewport-img");
  const viewportEmpty = $("#dash-b-viewport-empty");
  const urlInput = $("#dash-b-url");
  const bMeta = $("#dash-b-meta");
  const bView = $("#dash-b-view");
  const bStatus = $("#dash-b-status");
  
  if (m.closed) {
    viewportImg.classList.add("hidden");
    viewportEmpty.classList.remove("hidden");
    bMeta.innerHTML = "";
    bView.innerHTML = "";
    urlInput.value = "";
    bStatus.textContent = "Inactive";
    bStatus.className = "ml-auto text-[10px] px-2 py-0.5 rounded-full bg-zinc-950 text-dim border border-edge";
    return;
  }
  
  if (m.error) {
    bMeta.innerHTML = `<span class="text-danger font-mono text-xs">${esc(m.error)}</span>`;
    return;
  }
  
  bStatus.textContent = state.extConnected ? "Live Extension Connected" : "CDP Browser Control";
  bStatus.className = `ml-auto text-[10px] px-2 py-0.5 rounded-full border ${state.extConnected ? "bg-grn/10 text-grn border-grn/30 font-bold" : "bg-zinc-900 text-white border-edge font-bold"}`;
  
  if (m.url) urlInput.value = m.url;
  if (m.title || m.url) {
    bMeta.innerHTML = `<div class="truncate text-white font-bold text-xs">${esc(m.title || "Untitled")}</div><div class="truncate text-[10px] text-zinc-500 font-mono mt-0.5">${esc(m.url || "")}</div>`;
  }
  
  if (m.screenshot) {
    viewportImg.src = `data:image/png;base64,${m.screenshot}`;
    viewportImg.classList.remove("hidden");
    viewportEmpty.classList.add("hidden");
  } else if (!viewportImg.src) {
    viewportImg.classList.add("hidden");
    viewportEmpty.classList.remove("hidden");
  }
  
  if (m.text != null) {
    bView.innerHTML = esc(m.text || "(empty page)");
  }
}

// ── command index (the "/" menu, like the terminal) ──
const COMMANDS = [
  ["new chat", () => { messages.innerHTML = ""; send({ t: "new" }); }],
  ["browser — open & view a page", () => setTab("browser")],
  ["system — hardware & model picks", () => setTab("system")],
  ["profiles — switch / learn", () => setTab("profiles")],
  ["servers — running dev servers", () => setTab("runtime")],
  ["ports — free a stuck port", () => setTab("runtime")],
  ["/init — generate project context", () => send({ t: "init" })],
  ["compact — shrink the conversation", () => send({ t: "compact" })],
  ["mode: chat (talk only — never creates files)", () => { setMode("chat"); send({ t: "set_mode", mode: "chat" }); }],
  ["mode: auto (run by itself)", () => { setMode("auto"); send({ t: "set_mode", mode: "auto" }); }],
  ["mode: plan (research first)", () => { setMode("plan"); send({ t: "set_mode", mode: "plan" }); }],
  ["mode: debug (investigate via logs, console, network)", () => { setMode("debug"); send({ t: "set_mode", mode: "debug" }); }],
  ["mode: normal (ask per action)", () => { setMode("normal"); send({ t: "set_mode", mode: "normal" }); }],
  ["attach files to context", attachModal],
  ["incognito — don't save this chat", toggleIncognito],
  ["incognito — what it does & doesn't protect", incognitoInfoModal],
];

function commandsModal() {
  const c = openModal("Command index", `
    <input id="cmd-q" placeholder="Filter…" class="w-full bg-zinc-900 border border-edge rounded-full px-4 py-2 text-xs text-white mb-2 focus:outline-none focus:border-zinc-500" autofocus />
    <div id="cmd-list" class="space-y-0.5 max-h-[50vh] overflow-y-auto"></div>`);
  const list = $("#cmd-list", c), q = $("#cmd-q", c);
  const draw = (f = "") => {
    list.innerHTML = "";
    COMMANDS.filter(([l]) => l.toLowerCase().includes(f.toLowerCase())).forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.className = "w-full text-left px-3 py-2 rounded-xl hover:bg-zinc-900 text-xs text-zinc-300 flex items-center gap-2 transition";
      b.innerHTML = `<i data-lucide="chevron-right" class="w-3.5 h-3.5 text-dim"></i> ${esc(label)}`;
      b.onclick = () => { closeModal(); fn(); };
      list.appendChild(b);
    });
    icons();
  };
  draw();
  q.addEventListener("input", () => draw(q.value));
}

// ── Dashboard columns management ──
const dashTabs = $$(".dash-tab");
const dashViews = $$(".dash-view");

function setTab(tabName) {
  dashTabs.forEach(t => {
    const active = t.dataset.dashTab === tabName;
    t.classList.toggle("active", active);
  });
  dashViews.forEach(v => {
    const active = v.id === `dash-view-${tabName}`;
    v.classList.toggle("hidden", !active);
  });
  localStorage.setItem("lcli-active-tab", tabName);
  
  if (tabName === "runtime") {
    send({ t: "servers" });
    send({ t: "ports" });
  } else if (tabName === "profiles") {
    loadDashboardProfiles();
  } else if (tabName === "system") {
    loadDashboardSystem();
  }
}

dashTabs.forEach(t => {
  t.onclick = () => setTab(t.dataset.dashTab);
});

// Address bar events
const dashBrowserGo = () => {
  if (browserBusy) return;
  const urlInput = $("#dash-b-url");
  const url = urlInput.value.trim();
  if (!url) return;
  browserBusy = true;
  $("#dash-b-viewport-empty").innerHTML = `<span class="spin"></span><p class="text-xs text-zinc-400 mt-2">Connecting and loading URL…</p>`;
  $("#dash-b-viewport-empty").classList.remove("hidden");
  $("#dash-b-viewport-img").classList.add("hidden");
  send({ t: "browser_open", url });
};

$("#dash-b-open").onclick = dashBrowserGo;
$("#dash-b-url").addEventListener("keydown", e => { if (e.key === "Enter") dashBrowserGo(); });

$("#dash-b-shot").onclick = () => {
  if (browserBusy) return;
  send({ t: "browser_shot" });
};

$("#dash-b-live-btn").onclick = () => {
  send({ t: "browser_live", on: !liveViewOn });
};

// "How browser control works" guide (the ? button in the Browser tab).
$("#dash-b-help").onclick = () => {
  openModal("How browser control works", `
    <div class="space-y-4 text-[13px] leading-relaxed text-zinc-300">
      <p>The agent can drive a browser <b class="text-white">two ways</b>. You watch everything it does: an animated <b class="text-white">AI cursor</b> glides to each element with a small <span class="font-mono text-[11px] bg-zinc-900 border border-edge rounded px-1.5">click</span>/<span class="font-mono text-[11px] bg-zinc-900 border border-edge rounded px-1.5">type</span> label, targets flash a highlight, and this tab streams a <b class="text-white">LIVE view</b> while it works.</p>

      <div class="rounded-2xl border border-edge bg-panel p-3.5 space-y-1.5">
        <div class="text-xs font-bold text-white flex items-center gap-2"><i data-lucide="app-window" class="w-4 h-4"></i> 1 · Its own browser — for testing what it builds <span class="ml-auto text-[10px] text-grn font-mono">no setup</span></div>
        <p class="text-xs text-zinc-400">The agent launches a separate Chrome window it fully controls. Best for checking apps it just built or started. The viewport above shows what it sees; press the <i data-lucide="eye" class="w-3 h-3 inline"></i> eye to keep the live stream on.</p>
        <p class="text-xs"><span class="text-dim">Ask things like:</span> <i class="text-zinc-300">"start my app, open it in the browser and fix anything that looks broken"</i></p>
      </div>

      <div class="rounded-2xl border border-edge bg-panel p-3.5 space-y-1.5">
        <div class="text-xs font-bold text-white flex items-center gap-2"><i data-lucide="globe" class="w-4 h-4"></i> 2 · Your live browser — for real sites <span class="ml-auto text-[10px] text-warn font-mono">extension, one-time</span></div>
        <p class="text-xs text-zinc-400">Install the extension once: <span class="font-mono text-[11px]">chrome://extensions</span> → Developer mode → <b>Load unpacked</b> → select this repo's <span class="font-mono text-[11px]">extension/</span> folder. A ◆ bubble appears on pages; the header badge turns <span class="text-grn">live browser</span> when connected. The agent then acts on the tab <b class="text-white">you</b> are looking at — your real session, logins included.</p>
        <p class="text-xs"><span class="text-dim">Ask things like:</span> <i class="text-zinc-300">"open amazon.com and highlight the cheapest mechanical keyboard"</i></p>
      </div>

      <p class="text-xs text-dim"><b class="text-warn">Safety:</b> in <b>normal</b> mode the agent asks before every click and keystroke. In <b>auto</b> mode it acts on its own — be careful on pages with real forms or purchases.</p>
    </div>`);
};

$("#dash-b-close").onclick = () => {
  send({ t: "browser_close" });
};

const textToggle = $("#dash-b-text-toggle");
const bView = $("#dash-b-view");
textToggle.onclick = () => {
  const isHidden = bView.classList.toggle("hidden");
  const icon = $(".tr-icon", textToggle);
  if (icon) {
    icon.setAttribute("data-lucide", isHidden ? "chevron-down" : "chevron-up");
    icons();
  }
};

// Dashboard Toggle
$("#dashboard-toggle").onclick = () => {
  const dash = $("#dashboard");
  const isHidden = dash.classList.toggle("hidden");
  localStorage.setItem("lcli-dash-hidden", isHidden ? "true" : "false");
  updateBackdrop();
};

if (window.innerWidth < 1024) {
  $("#sidebar").classList.add("hidden");
  $("#dashboard").classList.add("hidden");
} else {
  if (localStorage.getItem("lcli-dash-hidden") === "true") {
    $("#dashboard").classList.add("hidden");
  }
}

// ── Backdrop drawer control ──
function updateBackdrop() {
  const isMobile = window.innerWidth < 1024;
  const sidebarOpen = !$("#sidebar").classList.contains("hidden");
  const dashboardOpen = !$("#dashboard").classList.contains("hidden");
  const backdrop = $("#backdrop");
  if (backdrop) {
    if (isMobile && (sidebarOpen || dashboardOpen)) {
      backdrop.classList.remove("hidden");
    } else {
      backdrop.classList.add("hidden");
    }
  }
}
$("#backdrop").addEventListener("click", () => {
  $("#sidebar").classList.add("hidden");
  $("#dashboard").classList.add("hidden");
  updateBackdrop();
});

// When the window crosses the overlay breakpoint, reset the panels for that
// mode: entering narrow hides them (they'd cover the chat as drawers);
// returning to wide restores them inline. Without this, resizing the window
// left the old panel state behind and the layout looked broken.
const OVERLAY_BREAK = 1024;
let wasNarrow = window.innerWidth < OVERLAY_BREAK;
function applyResponsivePanels() {
  const narrow = window.innerWidth < OVERLAY_BREAK;
  if (narrow !== wasNarrow) {
    wasNarrow = narrow;
    if (narrow) {
      $("#sidebar").classList.add("hidden");
      $("#dashboard").classList.add("hidden");
    } else {
      $("#sidebar").classList.remove("hidden");
      if (localStorage.getItem("lcli-dash-hidden") !== "true") $("#dashboard").classList.remove("hidden");
    }
  }
  updateBackdrop();
}
window.addEventListener("resize", applyResponsivePanels);

// ── input ──
const autogrow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 208) + "px"; };

// ── image paste (Ctrl+V a screenshot or copied image) ──
let pendingImages = []; // base64 (no data: prefix), max 4
function renderImagePreviews() {
  const box = $("#img-previews");
  if (!pendingImages.length) { box.classList.add("hidden"); box.classList.remove("flex"); box.innerHTML = ""; return; }
  box.classList.remove("hidden"); box.classList.add("flex");
  box.innerHTML = pendingImages.map((b, i) => `
    <div class="relative">
      <img src="data:image/png;base64,${b}" class="h-16 w-16 object-cover rounded-xl border border-edge" />
      <button data-i="${i}" type="button" class="img-rm absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-900 border border-edge text-dim hover:text-danger text-[10px] leading-none grid place-items-center" title="Remove image">✕</button>
    </div>`).join("");
  $$(".img-rm", box).forEach(b => b.onclick = () => { pendingImages.splice(Number(b.dataset.i), 1); renderImagePreviews(); });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && it.type.startsWith("image/"));
  if (!files.length) return; // plain text pastes keep their default behavior
  e.preventDefault();
  for (const it of files) {
    const f = it.getAsFile(); if (!f) continue;
    const r = new FileReader();
    r.onload = () => {
      if (pendingImages.length >= 4) { addNote("Up to 4 images per message.", "info"); return; }
      pendingImages.push(String(r.result).split(",")[1]);
      renderImagePreviews();
    };
    r.readAsDataURL(f);
  }
});

function submitText(text, images = []) { if ((!text && !images.length) || busy) return; cur = null; startLive(); send({ t: "chat", text, images }); }
function submit() {
  const t = input.value.trim();
  if ((!t && !pendingImages.length) || busy) return;
  submitText(t, pendingImages.slice());
  pendingImages = []; renderImagePreviews();
  input.value = ""; autogrow();
}
$("#form").addEventListener("submit", e => { e.preventDefault(); submit(); });
input.addEventListener("input", () => { autogrow(); if (input.value === "/") { input.value = ""; autogrow(); commandsModal(); } });
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
$("#stop").addEventListener("click", () => send({ t: "interrupt" }));
$("#new-chat").addEventListener("click", () => { messages.innerHTML = ""; cur = null; pendingTools = []; send({ t: "new" }); });
$("#sidebar-toggle").addEventListener("click", () => {
  $("#sidebar").classList.toggle("hidden");
  updateBackdrop();
});
$("#folder-btn").addEventListener("click", folderModal);
$("#attach").addEventListener("click", attachModal);
$("#model-info").addEventListener("click", modelInfoModal);
$("#compact-btn").addEventListener("click", () => send({ t: "compact" }));
$("#think-btn").addEventListener("click", () => send({ t: "set_thinking", on: !state.thinking }));
$("#incognito-btn").addEventListener("click", toggleIncognito);
$("#loop-warn-stop").addEventListener("click", () => { send({ t: "interrupt" }); hideLoopWarning(); });
$("#loop-warn-ok").addEventListener("click", hideLoopWarning);
$("#incog-what").addEventListener("click", incognitoInfoModal);
$("#incog-off").addEventListener("click", () => send({ t: "set_incognito", on: false }));
$("#sidebar-commands").addEventListener("click", commandsModal);
$$("#mode .mode-btn").forEach(b => b.addEventListener("click", () => { setMode(b.dataset.mode); send({ t: "set_mode", mode: b.dataset.mode }); }));

// Profiles creation learn
$("#dash-learn-go").onclick = () => {
  const n = $("#dash-learn-name").value.trim();
  if (n) {
    send({ t: "learn", name: n });
    $("#dash-learn-name").value = "";
    setTimeout(loadDashboardProfiles, 500);
  }
};

// Set default dashboard tab on load
const savedTab = localStorage.getItem("lcli-active-tab") || "browser";
setTab(savedTab);

icons();
setMode("normal");
loadModels();
connect();
input.focus();
