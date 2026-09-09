// Front end for local-cli's Web UI — full CLI parity in the browser.
// Talks to server.ts over a WebSocket (streamed agent loop) + REST endpoints
// for models / sessions / folders / profiles / servers.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let bootToken = "";
let connectionEpoch = 0;
let reconnectTimer = null;
const CLIENT_ID_KEY = "local-cli-web-client-id";
let clientId;
try {
  clientId = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) { clientId = crypto.randomUUID(); sessionStorage.setItem(CLIENT_ID_KEY, clientId); }
} catch { clientId = crypto.randomUUID(); }

// Safe JSON fetch: returns fallback so wrong-version/stale server won't crash UI.
async function getJSON(url, fallback = null) {
  try {
    const r = await fetch(url, { headers: bootToken ? { "X-Local-CLI-Token": bootToken } : {} });
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
let state = { model: "", cwd: "", contextWindow: 0, thinking: true, reasoningSource: "local_model_trace", packageManager: "auto", activeProfile: null, profiles: [], availablePM: [] };
let mode = "normal";
let browserBusy = false;
let incognito = { on: false, since: null };
let backendWarning = "";
let bubbleSeq = 0;
let activeRun = null;
const receivedRunSeq = new Map();

// ── markdown ──
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escAttr = esc;

function safeMarkdownUrl(raw) {
  try {
    const url = new URL(String(raw), location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function renderPlainInline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function renderInline(text) {
  const token = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let html = "", cursor = 0, match;
  while ((match = token.exec(text))) {
    html += renderPlainInline(text.slice(cursor, match.index));
    if (match[1] != null) html += `<code class="inline">${esc(match[1])}</code>`;
    else {
      const href = safeMarkdownUrl(match[3]);
      html += href
        ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${renderPlainInline(match[2])}</a>`
        : renderPlainInline(match[2]);
    }
    cursor = token.lastIndex;
  }
  return html + renderPlainInline(text.slice(cursor));
}

function md(src) {
  src = String(src ?? "");
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`); return `  ${blocks.length - 1}  `; });
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of src.split("\n")) {
    const ph = raw.match(/^  (\d+)  $/);
    if (ph) { close(); html += blocks[+ph[1]]; continue; }
    let m;
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { close(); html += `<h${m[1].length}>${renderInline(m[2])}</h${m[1].length}>`; }
    else if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) { if (list !== "ul") { close(); list = "ul"; html += "<ul>"; } html += `<li>${renderInline(m[1])}</li>`; }
    else if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) { if (list !== "ol") { close(); list = "ol"; html += "<ol>"; } html += `<li>${renderInline(m[1])}</li>`; }
    else if (raw.trim() === "") close();
    else { close(); html += `<p>${renderInline(raw)}</p>`; }
  }
  close();
  return html;
}

const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
const scroll = () => { messages.scrollTop = messages.scrollHeight; };
const relTime = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; };

// ── message bubbles ──
function bubble(role) {
  const id = `reasoning-${++bubbleSeq}`;
  const wrap = document.createElement("div");
  wrap.className = "flex gap-3 animate-rise";
  
  const av = role === "user"
    ? `<div class="shrink-0 w-7 h-7 rounded-full grid place-items-center text-xs bg-zinc-900 border border-edge text-zinc-300 font-mono">❯</div>`
    : `<div class="shrink-0 w-7 h-7 rounded-full grid place-items-center text-xs bg-white text-black font-mono">◆</div>`;
    
  wrap.innerHTML = `${av}<div class="flex-1 min-w-0">
    <div class="text-[11px] text-dim mb-1 font-semibold tracking-wide">${role === "user" ? "you" : "assistant"}</div>
    <div class="think-container hidden">
      <button type="button" class="think-header flex items-center justify-between" aria-expanded="false" aria-controls="${id}">
        <span class="flex items-center gap-1.5"><i data-lucide="brain" class="w-3 h-3 text-zinc-500"></i><span class="reasoning-source">Reasoning trace</span><span class="reasoning-time"></span></span>
        <i data-lucide="chevron-down" class="w-3.5 h-3.5 transition-transform duration-200 tr-icon"></i>
      </button>
      <div id="${id}" class="think-block hidden" role="region"></div>
    </div>
    <div class="prose content"></div>
  </div>`;
  
  messages.appendChild(wrap);

  const thinkContainer = $(".think-container", wrap);
  const thinkHeader = $(".think-header", wrap);
  const thinkBlock = $(".think-block", wrap);
  
  thinkHeader.onclick = () => {
    const isHidden = thinkBlock.classList.toggle("hidden");
    thinkHeader.setAttribute("aria-expanded", String(!isHidden));
    const icon = $(".think-header i.tr-icon", wrap);
    if (icon) {
      icon.setAttribute("data-lucide", isHidden ? "chevron-down" : "chevron-up");
      icons();
    }
  };

  icons();
  return { wrap, thinkContainer, thinkHeader, think: thinkBlock, content: $(".content", wrap), text: "", thought: "", thoughtStarted: 0 };
}

function addUser(text, images) {
  const b = bubble("user");
  b.content.textContent = text;
  if (images && images.length) {
    const row = document.createElement("div");
    row.className = "flex flex-wrap gap-2 mt-2";
    images.forEach((im, index) => {
      if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(im)) return;
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${im}`;
      image.alt = `Attached image ${index + 1}`;
      image.className = "max-h-40 rounded-xl border border-edge";
      row.appendChild(image);
    });
    b.content.appendChild(row);
  }
  scroll();
}
const ensureAssistant = () => (cur ||= bubble("assistant"));

function addText(v, think) {
  const stick = atBottom();
  const b = ensureAssistant();
  if (think) {
    if (!b.thoughtStarted) b.thoughtStarted = Date.now();
    b.thought += v;
    b.think.textContent = b.thought;
    b.thinkContainer.classList.remove("hidden");
    b.think.classList.remove("hidden");
    b.thinkHeader.setAttribute("aria-expanded", "true");
    const source = $(".reasoning-source", b.wrap);
    if (source) source.textContent = state.reasoningSource === "local_model_trace" ? "Local model reasoning trace" : "Provider reasoning summary";
  } else {
    b.text += v;
    b.content.innerHTML = md(b.text) + '<span class="caret"></span>';
  }
  if (stick) scroll();
}

function finishStreaming() {
  $$(".caret").forEach(c => c.remove());
  if (cur?.thoughtStarted) {
    const elapsed = Math.max(0, Date.now() - cur.thoughtStarted);
    const label = $(".reasoning-time", cur.wrap);
    if (label) label.textContent = ` · ${formatDuration(elapsed)}`;
  }
  cur = null;
}

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

function prettyToolArgs(raw) {
  try { return JSON.stringify(JSON.parse(raw || "{}"), null, 2); } catch { return String(raw || ""); }
}

function addTool(name, summary, toolId, args) {
  finishStreaming();
  const stick = atBottom();
  const el = document.createElement("div");
  el.className = "rounded-2xl border border-edge border-l-[3px] border-l-zinc-500 bg-panel animate-pop overflow-hidden";
  el.dataset.toolId = toolId || "";
  el.innerHTML = `<button type="button" class="head w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-panel2 transition" aria-expanded="false">
      <i data-lucide="${TOOL_IC[name] ?? "wrench"}" class="w-4 h-4 text-zinc-400 ic"></i>
      <span class="font-mono text-xs font-semibold text-white">${name}</span>
      <span class="font-mono text-[11px] text-dim flex-1 min-w-0 truncate ml-1">${esc(summary || "")}</span>
      <span class="tool-phase text-[11px] text-dim">queued</span><span class="state"><span class="spin"></span></span></button>
    <div class="body hidden px-3 pb-2.5"><pre class="m-0 bg-bg rounded-xl p-2.5 text-[11px] font-mono text-zinc-300 overflow-auto max-h-60 whitespace-pre-wrap border border-edge"></pre></div>`;
  messages.appendChild(el);
  const head = $(".head", el);
  head.onclick = () => {
    const hidden = $(".body", el).classList.toggle("hidden");
    head.setAttribute("aria-expanded", String(!hidden));
  };
  const pre = $(".body pre", el);
  if (args) pre.textContent = `Arguments\n${prettyToolArgs(args)}`;
  pendingTools.push({ id: toolId, name, el, args: args || "" });
  icons();
  if (stick) scroll();
}

function updateToolProgress(m) {
  const t = m.toolId ? pendingTools.find(tool => tool.id === m.toolId) : pendingTools.findLast?.(tool => tool.name === m.name);
  if (!t) return;
  const phase = $(".tool-phase", t.el);
  if (phase) phase.textContent = m.phase === "running" ? "running" : (m.phase || "preparing");
  if (m.args) t.args = m.args;
}

function fillTool(name, result, toolId, durationMs, phaseName) {
  const stick = atBottom();
  const i = toolId ? pendingTools.findIndex(t => t.id === toolId) : pendingTools.findIndex(t => t.name === name);
  const t = i >= 0 ? pendingTools.splice(i, 1)[0] : null;
  if (!t) return;
  const err = /^Error|not found|denied|Exit [1-9]|timed out|NOT running/i.test(result);
  t.el.classList.remove("border-l-zinc-500");
  t.el.classList.add(err ? "border-l-danger" : "border-l-white");
  $(".ic", t.el).classList.remove("text-zinc-400");
  $(".ic", t.el).classList.add(err ? "text-danger" : "text-white");
  $(".state", t.el).innerHTML = err ? '<i data-lucide="x" class="w-4 h-4 text-danger"></i>' : '<i data-lucide="check" class="w-4 h-4 text-zinc-400"></i>';
  const phase = $(".tool-phase", t.el);
  if (phase) phase.textContent = `${phaseName || (err ? "failed" : "completed")}${Number.isFinite(durationMs) ? ` · ${formatDuration(durationMs)}` : ""}`;
  const pre = $(".body pre", t.el);
  const argsText = t.args ? `Arguments\n${prettyToolArgs(t.args)}\n\n` : "";
  pre.textContent = argsText + `Result\n${(result || "").split("\n").slice(0, 40).join("\n")}`;
  $(".body", t.el).classList.remove("hidden");
  icons();
  if (stick) scroll();
}

function addNote(v, kind) {
  const d = document.createElement("div");
  const cls = kind === "error" ? "text-danger bg-red-950/20 border-red-900/30" : "text-dim bg-zinc-900/50 border-edge";
  d.className = `text-[12px] font-mono whitespace-pre-wrap rounded-xl border px-3.5 py-2 animate-rise ${cls}`;
  d.textContent = v; messages.appendChild(d); scroll();
}

// A generated image, shown inline. Click to open it full size in a new tab.
function addImage(path, base64) {
  finishStreaming();
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(base64 || "")) { addNote("Generated image payload was invalid.", "error"); return; }
  const src = `data:image/png;base64,${base64}`;
  const d = document.createElement("div");
  d.className = "rounded-2xl border border-edge bg-panel overflow-hidden animate-rise max-w-lg";
  d.innerHTML = `<img src="${src}" alt="${escAttr(path)}" class="w-full h-auto block cursor-zoom-in" />
    <div class="px-3.5 py-2 text-[11px] font-mono text-dim border-t border-edge/60 truncate">${esc(path)}</div>`;
  d.querySelector("img").onclick = () => window.open(src, "_blank", "noopener,noreferrer");
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
      mkBtn("Allow", "bg-white text-black hover:bg-zinc-200", () => { send({ t: "permission", id: m.id, callId: m.callId, approved: true }); done("Allowed"); }),
      mkBtn("Always allow " + m.tool, "border border-zinc-500 text-zinc-300 hover:text-white hover:bg-zinc-900", () => { send({ t: "permission", id: m.id, callId: m.callId, approved: true, always: true }); done("Always allowed"); }),
      mkBtn("Deny", "border border-edge text-zinc-400 hover:text-danger hover:border-danger hover:bg-zinc-950", () => { send({ t: "permission", id: m.id, callId: m.callId, approved: false }); done("Denied"); }),
    );
  } else {
    el.innerHTML = `<div class="flex items-center gap-2 text-xs font-semibold text-white"><i data-lucide="circle-help" class="w-4 h-4 text-accent"></i><span>${esc(m.question)}</span></div><div class="opts flex flex-wrap gap-2"></div>`;
    const opts = el.querySelector(".opts");
    m.options.forEach(o => opts.append(mkBtn(o, "border border-edge bg-zinc-900 text-zinc-300 hover:border-white hover:text-white", () => { send({ t: "choice", id: m.id, answer: o }); done(o); })));
  }
  messages.appendChild(el); icons(); scroll();
}

// ── live indicator ──
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const min = Math.floor(ms / 60_000), sec = Math.floor((ms % 60_000) / 1_000);
  return `${min}m ${sec}s`;
}

const PHASE_LABEL = {
  loading: "loading model", prefill: "reading prompt", generating: "starting generation",
  reasoning: "reasoning", answer: "writing answer", tool: "running tool",
};

function beginRun(m = {}) {
  const at = Number(m.at) || Date.now();
  activeRun = {
    id: m.runId || null, startedAt: at, phase: "prefill", phaseAt: at,
    durations: {}, heartbeat: "", usage: null, model: m.model || state.model,
    mode: m.mode || mode, toolCount: 0,
  };
}

function setRunPhase(phase, at = Date.now()) {
  if (!activeRun) beginRun({ at });
  if (activeRun.phase && activeRun.phase !== phase) {
    activeRun.durations[activeRun.phase] = (activeRun.durations[activeRun.phase] || 0) + Math.max(0, at - activeRun.phaseAt);
  }
  activeRun.phase = phase;
  activeRun.phaseAt = at;
  activeRun.heartbeat = "";
  livePhase = phase;
  liveThinking = phase === "reasoning";
  renderLive();
}

function startLive() {
  busy = true; liveTokens = 0; liveToolName = ""; liveThinking = false;
  if (!activeRun) beginRun({ at: Date.now() });
  liveStart = activeRun.startedAt;
  $("#send").classList.add("hidden"); $("#stop").classList.remove("hidden");
  liveEl.classList.remove("hidden"); liveEl.classList.add("flex");
  clearInterval(liveTimer); liveTimer = setInterval(renderLive, 250); renderLive();
}
function renderLive() {
  const now = Date.now();
  const total = now - (activeRun?.startedAt || liveStart || now);
  const phaseElapsed = now - (activeRun?.phaseAt || liveStart || now);
  if (awaiting) { liveEl.innerHTML = `<span class="text-warn">⏸ awaiting your approval — click <b>Allow</b> or <b>Deny</b> above</span>`; return; }
  const phase = activeRun?.phase || livePhase || "prefill";
  const label = phase === "tool" && liveToolName ? `running ${esc(liveToolName)}` : (PHASE_LABEL[phase] || esc(phase));
  const tok = liveTokens ? `<span>output ~${liveTokens.toLocaleString()} tok</span>` : "";
  const heartbeat = activeRun?.heartbeat ? `<span class="text-dim">${esc(activeRun.heartbeat)}</span>` : "";
  liveEl.innerHTML = `<span class="spin" aria-hidden="true"></span><strong>${label}</strong><span>${formatDuration(phaseElapsed)} phase</span><span>${formatDuration(total)} total</span>${tok}${heartbeat}<span class="ml-auto text-dim">Stop is always available</span>`;
}

function addRunSummary(m) {
  if (!activeRun) return;
  const endedAt = Number(m.at) || Date.now();
  if (activeRun.phase) activeRun.durations[activeRun.phase] = (activeRun.durations[activeRun.phase] || 0) + Math.max(0, endedAt - activeRun.phaseAt);
  const duration = Number(m.durationMs) || Math.max(0, endedAt - activeRun.startedAt);
  const usage = m.usage || activeRun.usage;
  const outcome = ["completed", "cancelled", "error"].includes(m.outcome) ? m.outcome : "error";
  const el = document.createElement("section");
  el.className = `run-summary ${outcome}`;
  const phases = Object.entries(activeRun.durations).filter(([, ms]) => ms > 0).map(([name, ms]) => `${PHASE_LABEL[name] || name} ${formatDuration(ms)}`);
  el.innerHTML = `<div class="run-summary-main"><span class="run-outcome">${esc(outcome)}</span><span>${formatDuration(duration)}</span><span>${Number(m.toolCount ?? activeRun.toolCount) || 0} tool calls</span>${usage ? `<span>${Number(usage.inTok || 0).toLocaleString()} in · ${Number(usage.outTok || 0).toLocaleString()} out · ${Number(usage.tps || 0).toFixed(1)} t/s</span>` : ""}</div>${phases.length ? `<div class="run-phases">${phases.map(esc).join(" · ")}</div>` : ""}`;
  messages.appendChild(el);
  scroll();
}

function stopLive() {
  busy = false; awaiting = false; livePhase = null; clearInterval(liveTimer); liveTimer = null;
  $("#send").classList.remove("hidden"); $("#stop").classList.add("hidden");
  liveEl.classList.add("hidden"); liveEl.classList.remove("flex");
  activeRun = null;
}

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
  const thinkBtn = $("#think-btn");
  thinkBtn.classList.toggle("text-white", !!c.thinking);
  thinkBtn.classList.toggle("border-zinc-400", !!c.thinking);
  thinkBtn.classList.toggle("active", !!c.thinking);
  thinkBtn.setAttribute("aria-pressed", String(!!c.thinking));
  thinkBtn.title = c.thinking
    ? "Model reasoning generation is on; returned reasoning is shown live"
    : "Model reasoning generation is off";
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
function setConnectionState(kind, label) {
  const el = $("#conn");
  el.className = `connection-dot ml-auto ${kind === "connected" ? "bg-grn" : kind === "connecting" ? "bg-warn" : "bg-danger"}`;
  el.setAttribute("aria-label", label);
  el.title = label;
}

async function connect() {
  const epoch = ++connectionEpoch;
  clearTimeout(reconnectTimer);
  setConnectionState("connecting", "Connecting to local-cli");
  try {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error(`bootstrap HTTP ${response.status}`);
    const bootstrap = await response.json();
    if (!bootstrap?.token || bootstrap.protocol !== 2) throw new Error("incompatible local-cli server");
    bootToken = bootstrap.token;
  } catch {
    if (epoch !== connectionEpoch) return;
    setConnectionState("disconnected", "Disconnected — retrying");
    reconnectTimer = setTimeout(connect, 1200);
    return;
  }

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(bootToken)}&clientId=${encodeURIComponent(clientId)}`);
  ws = socket;
  socket.onopen = () => {
    if (epoch !== connectionEpoch) { socket.close(); return; }
    setConnectionState("connected", "Connected");
  };
  socket.onclose = () => {
    if (epoch !== connectionEpoch) return;
    setConnectionState("disconnected", "Disconnected — retrying");
    finishStreaming(); stopLive();
    reconnectTimer = setTimeout(connect, 1200);
  };
  socket.onmessage = (ev) => {
    if (epoch !== connectionEpoch) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.runId && Number.isSafeInteger(m.seq)) {
      const previous = receivedRunSeq.get(m.runId) || 0;
      if (m.seq <= previous) return;
      receivedRunSeq.set(m.runId, m.seq);
    }
    switch (m.t) {
      case "ready":
        if (!m.config || m.protocol !== 2) { addNote("The web page and server protocol versions do not match. Restart `bun run web`, then reload this page.", "error"); break; }
        applyConfig(m.config); setContext(0, m.config.contextWindow);
        send({ t: "servers" }); send({ t: "ports" });
        break;
      case "config": applyConfig(m.config); break;
      case "run_start": beginRun(m); startLive(); break;
      case "user": addUser(m.text, m.images); cur = null; break;
      case "text":
        if (!busy) startLive();
        if (m.think && activeRun?.phase !== "reasoning") setRunPhase("reasoning", Number(m.at) || Date.now());
        else if (!m.think && activeRun?.phase !== "answer") setRunPhase("answer", Number(m.at) || Date.now());
        addText(m.v, m.think); break;
      case "tool_progress":
        if (m.phase === "running") { liveToolName = m.name; setRunPhase("tool", Number(m.at) || Date.now()); }
        updateToolProgress(m); renderLive(); break;
      case "tool_call":
        if (!busy) startLive(); liveToolName = m.name; activeRun && activeRun.toolCount++;
        setBrowserAction(m.name, m.summary); addTool(m.name, m.summary, m.toolId, m.args); break;
      case "tool_result": setBrowserAction(null); fillTool(m.name, m.result, m.toolId, m.durationMs, m.phase); break;
      case "phase": setRunPhase(m.phase, Number(m.at) || Date.now()); break;
      case "status": setRunPhase(m.phase, Number(m.at) || Date.now()); break; // protocol v1 compatibility
      case "heartbeat":
        if (!activeRun) beginRun(m);
        activeRun.heartbeat = m.message || `Still ${m.phase || "working"}`;
        if (m.phase && activeRun.phase !== m.phase) setRunPhase(m.phase, Number(m.at) || Date.now());
        renderLive(); break;
      case "progress": liveTokens = Number(m.tok) || 0; renderLive(); break;
      case "usage":
        if (activeRun) activeRun.usage = { inTok: m.inTok, outTok: m.outTok, tps: m.tps };
        renderLive(); break;
      case "notice": addNote(m.v, "info"); break;
      case "error": addNote(m.v, "error"); break;
      case "permission": addAsk(m); break;
      case "choice": addAsk(m); break;
      case "plan_approval": addPlanApproval(m); break;
      case "context": setContext(m.used, m.limit); break;
      case "mode": setMode(m.mode); break;
      case "loop_warning": showLoopWarning(m); break;
      case "image": addImage(m.path, m.data); break;
      case "incognito": {
        const changed = incognito.on !== !!m.state.on;
        applyIncognito(m.state, m.backendWarning);
        if (changed) {
          addNote(m.state.on
            ? "Incognito on — this conversation is not being saved. Lookups use a throwaway browser; file edits still change your disk and cannot be undone here."
            : "Incognito off — chats are saved again. Nothing from the private session was persisted, and its setting changes were discarded.", "info");
        } else if (m.state.on) addNote("Incognito is on — this conversation is not being saved.", "info");
        break;
      }
      case "sessions": renderSessions(m.list, m.active); break;
      case "load": renderLoaded(m.messages); break;
      case "servers": renderDashboardServers(m.list); break;
      case "ports": renderDashboardPorts(m.list); break;
      case "browser_state": browserBusy = false; renderBrowserState(m); break;
      case "browser_frame": renderBrowserFrame(m.data); break;
      case "browser_live": liveViewOn = !!m.on; $("#dash-b-live-btn").classList.toggle("text-grn", liveViewOn); break;
      case "ui_action":
        if (m.action === "files") attachModal();
        else if (m.action === "models") { $("#model").focus(); addNote("Choose a model from the Model control in the run bar.", "info"); }
        else if (m.action === "sessions") { $("#sidebar").classList.remove("hidden"); updateBackdrop(); $("#sessions").focus?.(); }
        else if (m.action === "profiles") { $("#dashboard").classList.remove("hidden"); setTab("profiles"); updateBackdrop(); }
        break;
      case "cleared": messages.innerHTML = ""; cur = null; pendingTools = []; break;
      case "run_end":
        finishStreaming(); addRunSummary(m); stopLive(); setBrowserAction(null); hideLoopWarning(); autoSwitched = false;
        if (m.outcome === "cancelled") addNote("Run cancelled.", "info");
        break;
      case "turn_end": finishStreaming(); stopLive(); setBrowserAction(null); hideLoopWarning(); autoSwitched = false; break;
    }
  };
}

function addPlanApproval(m) {
  finishStreaming();
  const el = document.createElement("div");
  el.className = "rounded-md border border-zinc-600 bg-panel p-4 animate-pop space-y-3";
  el.innerHTML = `<div class="flex items-center gap-2 text-sm font-semibold"><i data-lucide="clipboard-check" class="w-4 h-4 text-warn"></i><span>Plan proposed</span></div><div class="prose plan-copy">${md(m.plan || "")}</div><div class="opts flex flex-wrap gap-2"></div>`;
  awaiting = true; renderLive();
  const done = (decision, label) => {
    awaiting = false; renderLive();
    send({ t: "plan_decision", id: m.id, decision });
    const opts = $(".opts", el); opts.textContent = `→ ${label}`; opts.className = "opts text-xs text-dim";
  };
  const opts = $(".opts", el);
  opts.append(
    mkBtn("Approve and build", "bg-white text-black hover:bg-zinc-200", () => done("approve", "Approved — implementation continues in this run")),
    mkBtn("Keep planning", "border border-edge text-zinc-300", () => done("keep", "Continue refining the plan")),
    mkBtn("Reject", "border border-edge text-zinc-400 hover:text-danger", () => done("reject", "Rejected")),
  );
  messages.appendChild(el); icons(); scroll();
}

// ── modal helper ──
const modal = $("#modal"), modalCard = $("#modal-card");
let modalReturnFocus = null;
function openModal(title, bodyHTML) {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalCard.innerHTML = `<div class="flex items-center gap-2 px-4 py-3 border-b border-edge/60">
    <h2 id="modal-title" class="font-semibold text-sm flex-1 text-white">${esc(title)}</h2>
    <button id="modal-x" type="button" aria-label="Close dialog" class="text-dim hover:text-white transition"><i data-lucide="x" class="w-4 h-4"></i></button></div>
    <div class="overflow-y-auto p-4">${bodyHTML}</div>`;
  modalCard.setAttribute("aria-labelledby", "modal-title");
  modalCard.removeAttribute("aria-label");
  modal.classList.remove("hidden"); icons();
  $("#modal-x").onclick = closeModal;
  requestAnimationFrame(() => (modalCard.querySelector("[autofocus], input, select, textarea, button") || modalCard).focus());
  return modalCard;
}
function closeModal() {
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target?.isConnected) target.focus();
}
modal.onclick = (e) => { if (e.target === modal) closeModal(); };
document.addEventListener("keydown", (e) => {
  if (modal.classList.contains("hidden")) return;
  if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  if (e.key !== "Tab") return;
  const focusable = $$("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])", modalCard)
    .filter(el => !el.classList.contains("hidden"));
  if (!focusable.length) { e.preventDefault(); modalCard.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── models ──
async function loadModels() {
  try {
    const list = await getJSON("/api/models", []);
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

// ── folder browser helpers ──
function getParentDir(dir) {
  let n = (dir || "").replace(/[\/\\]+/g, "/").replace(/\/+$/, "");
  if (!n || n === "/" || /^[a-zA-Z]:$/.test(n)) return n.length === 2 ? n + "/" : "/";
  const idx = n.lastIndexOf("/");
  if (idx <= 0) return /^[a-zA-Z]:/.test(n) ? n.slice(0, 2) + "/" : "/";
  let p = n.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(p)) p += "/";
  return p;
}

function parseBreadcrumbs(dir) {
  const norm = (dir || "").replace(/\\/g, "/");
  const isWin = /^[a-zA-Z]:/.test(norm);
  const parts = norm.split("/").filter(Boolean);
  const crumbs = [];
  if (isWin) {
    const drive = parts[0].includes(":") ? parts[0] : parts[0] + ":";
    let acc = drive + "\\";
    crumbs.push({ label: drive.toUpperCase() + "\\", path: acc });
    for (let i = 1; i < parts.length; i++) {
      acc += (acc.endsWith("\\") ? "" : "\\") + parts[i];
      crumbs.push({ label: parts[i], path: acc });
    }
  } else {
    let acc = "/";
    crumbs.push({ label: "/", path: "/" });
    for (let i = 0; i < parts.length; i++) {
      acc = acc === "/" ? "/" + parts[i] : acc + "/" + parts[i];
      crumbs.push({ label: parts[i], path: acc });
    }
  }
  return crumbs;
}

// ── folder browser ──
async function browse(path, { multi = false, onPick } = {}) {
  const data = await getJSON(`/api/dir?path=${encodeURIComponent(path)}`);
  if (!data) { $(".overflow-y-auto", modalCard).innerHTML = `<div class="text-danger text-sm">Couldn't list that folder. Make sure the web server is up to date (restart <span class="font-mono">bun run web</span>).</div>`; return; }
  const c = modalCard;
  const crumbs = parseBreadcrumbs(data.dir);
  const drives = Array.isArray(data.drives) ? data.drives : [];

  $(".overflow-y-auto", c).innerHTML = `
    ${drives.length > 0 ? `
      <div class="flex items-center gap-1.5 mb-2 overflow-x-auto scrollbar-none pb-0.5">
        <span class="text-[11px] font-medium text-dim mr-1 shrink-0">Drives:</span>
        ${drives.map(d => {
          const active = data.dir.toLowerCase().startsWith(d.slice(0, 2).toLowerCase());
          return `<button data-drive="${esc(d)}" class="drive-chip px-2.5 py-1 rounded-lg text-xs font-mono font-semibold transition shrink-0 ${active ? "bg-white text-black font-bold shadow-sm" : "bg-zinc-900 border border-edge text-zinc-300 hover:text-white hover:bg-zinc-800"}">${esc(d)}</button>`;
        }).join("")}
      </div>
    ` : ""}

    <form id="browse-form" class="flex items-center gap-1.5 mb-2">
      <button id="browse-up" type="button" title="Go to parent folder" class="px-2.5 py-1.5 rounded-xl border border-edge bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs flex items-center gap-1 transition shrink-0 ${data.isRoot ? "opacity-40 cursor-not-allowed" : ""}">
        <i data-lucide="arrow-up" class="w-3.5 h-3.5"></i>
        <span class="font-mono text-[11px]">Up</span>
      </button>
      <div class="relative flex-1">
        <input id="browse-input" type="text" value="${esc(data.dir)}" spellcheck="false" class="w-full bg-zinc-950 border border-edge focus:border-zinc-500 rounded-xl px-3 py-1.5 text-xs font-mono text-white placeholder-zinc-500 outline-none transition" />
      </div>
      <button type="submit" class="px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs transition shrink-0">Go</button>
    </form>

    <div class="flex items-center gap-1 overflow-x-auto pb-1 mb-2 text-xs font-mono scrollbar-none">
      ${crumbs.map((cr, i) => `
        <button data-crumb-path="${esc(cr.path)}" class="crumb-btn text-xs text-zinc-400 hover:text-white hover:underline transition shrink-0 ${i === crumbs.length - 1 ? "text-white font-bold" : ""}">${esc(cr.label)}</button>
        ${i < crumbs.length - 1 ? `<span class="text-zinc-600 shrink-0">/</span>` : ""}
      `).join("")}
    </div>

    <div class="space-y-0.5 max-h-[44vh] overflow-y-auto border border-edge bg-zinc-950 rounded-2xl p-1.5">
      ${data.entries.length === 0 ? `<div class="p-6 text-center text-dim text-xs">This folder is empty.</div>` : data.entries.map((e, i) => `
        <div data-i="${i}" data-dir="${e.isDir}" data-name="${esc(e.name)}" class="entry flex items-center gap-2 px-2.5 py-2 rounded-xl hover:bg-zinc-900 cursor-pointer transition select-none">
          ${multi && !e.isDir ? `<input type="checkbox" class="chk accent-white cursor-pointer" />` : `<span class="w-3.5"></span>`}
          <i data-lucide="${e.isDir ? (e.name === ".." ? "corner-left-up" : "folder") : "file"}" class="w-4 h-4 shrink-0 ${e.isDir ? "text-white" : "text-dim"}"></i>
          <span class="text-xs font-mono truncate ${e.name === ".." ? "text-dim" : "text-zinc-300"}">${esc(e.name)}</span>
        </div>`).join("")}
    </div>

    <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-edge/60">
      <div class="text-[11px] font-mono text-dim truncate max-w-[280px]">
        ${multi ? `<span id="sel-count">0 items selected</span>` : `<span class="text-zinc-400">Selected:</span> <span class="text-white">${esc(data.dir)}</span>`}
      </div>
      <div class="flex items-center gap-2">
        ${multi ? `<button id="attach-go" class="px-4 py-2 rounded-full bg-white text-black font-bold text-xs hover:bg-zinc-200 transition">Attach selected</button>` : `<button id="use-dir" class="px-4 py-2 rounded-full bg-white text-black font-bold text-xs hover:bg-zinc-200 transition">Use this folder</button>`}
        <button id="browse-close" class="px-4 py-2 rounded-full border border-edge text-xs text-dim hover:text-white transition">Cancel</button>
      </div>
    </div>`;

  icons();
  c.__dir = data.dir;

  const updateSelCount = () => {
    const count = $$(".entry .chk:checked", c).length;
    const countEl = $("#sel-count", c);
    if (countEl) countEl.textContent = `${count} item${count === 1 ? "" : "s"} selected`;
  };

  $$(".entry", c).forEach(row => {
    row.onclick = (e) => {
      if (e.target.classList.contains("chk")) {
        updateSelCount();
        return;
      }
      const name = row.dataset.name, isDir = row.dataset.dir === "true";
      if (isDir) {
        let next;
        if (name === "..") {
          next = getParentDir(data.dir);
        } else {
          const sep = (data.dir.includes("\\") || /^[a-zA-Z]:/.test(data.dir)) ? "\\" : "/";
          next = data.dir.endsWith("/") || data.dir.endsWith("\\") ? (data.dir + name) : (data.dir + sep + name);
        }
        browse(next, { multi, onPick });
      } else if (multi) {
        const chk = $(".chk", row);
        if (chk) { chk.checked = !chk.checked; updateSelCount(); }
      }
    };
  });

  $$(".drive-chip", c).forEach(b => {
    b.onclick = () => browse(b.dataset.drive, { multi, onPick });
  });

  const upBtn = $("#browse-up", c);
  if (upBtn && !data.isRoot) {
    upBtn.onclick = () => browse(getParentDir(data.dir), { multi, onPick });
  }

  const form = $("#browse-form", c);
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const val = $("#browse-input", c).value.trim();
      if (val) browse(val, { multi, onPick });
    };
  }

  $$(".crumb-btn", c).forEach(b => {
    b.onclick = () => browse(b.dataset.crumbPath, { multi, onPick });
  });

  $("#browse-close").onclick = closeModal;
  if (multi) {
    $("#attach-go").onclick = () => {
      const sep = (data.dir.includes("\\") || /^[a-zA-Z]:/.test(data.dir)) ? "\\" : "/";
      const sel = $$(".entry", c).filter(r => $(".chk", r)?.checked).map(r => {
        const name = r.dataset.name;
        return data.dir.endsWith("/") || data.dir.endsWith("\\") ? (data.dir + name) : (data.dir + sep + name);
      });
      if (sel.length) { send({ t: "add_files", paths: sel }); closeModal(); }
    };
  } else {
    $("#use-dir").onclick = () => onPick(c.__dir);
  }
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
  ["new chat", () => send({ t: "new" })],
  ["browser — open & view a page", () => setTab("browser")],
  ["system — hardware & model picks", () => setTab("system")],
  ["profiles — switch / learn", () => setTab("profiles")],
  ["servers — running dev servers", () => setTab("runtime")],
  ["ports — free a stuck port", () => setTab("runtime")],
  ["/init — generate project context", () => send({ t: "init" })],
  ["compact — shrink the conversation", () => send({ t: "compact" })],
  ["mode: chat (talk only — never creates files)", () => send({ t: "set_mode", mode: "chat" })],
  ["mode: auto (run by itself)", () => send({ t: "set_mode", mode: "auto" })],
  ["mode: plan (research first)", () => send({ t: "set_mode", mode: "plan" })],
  ["mode: debug (investigate via logs, console, network)", () => send({ t: "set_mode", mode: "debug" })],
  ["mode: normal (ask per action)", () => send({ t: "set_mode", mode: "normal" })],
  ["attach files to context", attachModal],
  ["incognito — don't save this chat", toggleIncognito],
  ["incognito — what it does & doesn't protect", incognitoInfoModal],
];
let serverCommands = [];

async function loadCommandRegistry() {
  const list = await getJSON("/api/commands", []);
  serverCommands = Array.isArray(list) ? list.filter(c => c && typeof c.name === "string" && typeof c.description === "string") : [];
}

function stageSlashCommand(name) {
  input.value = `/${name} `;
  autogrow();
  input.focus();
}

function commandsModal() {
  const c = openModal("Command index", `
    <input id="cmd-q" placeholder="Filter…" class="w-full bg-zinc-900 border border-edge rounded-full px-4 py-2 text-xs text-white mb-2 focus:outline-none focus:border-zinc-500" autofocus />
    <div id="cmd-list" class="space-y-0.5 max-h-[50vh] overflow-y-auto"></div>`);
  const list = $("#cmd-list", c), q = $("#cmd-q", c);
  const draw = (f = "") => {
    list.innerHTML = "";
    const registry = serverCommands.map(command => [`/${command.name} — ${command.description}`, () => stageSlashCommand(command.name)]);
    [...COMMANDS, ...registry].filter(([l]) => l.toLowerCase().includes(f.toLowerCase())).forEach(([label, fn]) => {
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
      <img src="data:image/png;base64,${b}" alt="Image ${i + 1} ready to send" class="h-16 w-16 object-cover rounded-xl border border-edge" />
      <button data-i="${i}" type="button" aria-label="Remove image ${i + 1}" class="img-rm absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-900 border border-edge text-dim hover:text-danger text-[10px] leading-none grid place-items-center" title="Remove image">✕</button>
    </div>`).join("");
  $$(".img-rm", box).forEach(b => b.onclick = () => { pendingImages.splice(Number(b.dataset.i), 1); renderImagePreviews(); });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && it.type.startsWith("image/"));
  if (!files.length) return; // plain text pastes keep their default behavior
  e.preventDefault();
  for (const it of files) {
    const f = it.getAsFile(); if (!f) continue;
    if (f.size > 5_000_000) { addNote(`Image "${f.name || "clipboard image"}" is larger than 5 MB. Resize it before attaching.`, "error"); continue; }
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
  if (t.startsWith("/") && !pendingImages.length) {
    send({ t: "slash", input: t });
    input.value = ""; autogrow();
    return;
  }
  submitText(t, pendingImages.slice());
  pendingImages = []; renderImagePreviews();
  input.value = ""; autogrow();
}
$("#form").addEventListener("submit", e => { e.preventDefault(); submit(); });
input.addEventListener("input", () => { autogrow(); if (input.value === "/") { input.value = ""; autogrow(); commandsModal(); } });
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
$("#stop").addEventListener("click", () => send({ t: "interrupt" }));
$("#new-chat").addEventListener("click", () => send({ t: "new" }));
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
$$("#mode .mode-btn").forEach(b => b.addEventListener("click", () => send({ t: "set_mode", mode: b.dataset.mode })));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); commandsModal(); }
});

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
connect().then(() => Promise.all([loadModels(), loadCommandRegistry()]));
input.focus();
