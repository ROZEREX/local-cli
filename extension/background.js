// Service worker: the ONLY part allowed to open a localhost WebSocket (content
// scripts are blocked by page CSP). Keeps one WS to the local-cli server and
// relays between it and the active tab's content script. Also handles the
// "background" commands (open/navigate tabs) itself.

// The server may self-heal onto a nearby port, so scan a small range and stick to
// whichever answers. Override by editing this list if you run on a custom port.
const PORTS = [4317, 4318, 4319, 4320, 4321];
const BG_ACTIONS = new Set(["open_tab", "navigate", "list_tabs"]);
let ws = null;
let pi = 0;
let activeTabId = null;
let reconnectTimer = null;
const keepPorts = new Set();

function wsUrl() { return `ws://localhost:${PORTS[pi]}/ext`; }

function connect() {
  let opened = false, sock;
  try { sock = new WebSocket(wsUrl()); } catch { advance(); return; }
  ws = sock;
  sock.onopen = () => { opened = true; pushStatus(true); };
  sock.onerror = () => { try { sock.close(); } catch {} };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    pushStatus(false);
    if (!opened) advance();          // wrong port — try the next one
    scheduleReconnect();             // (same port if it had connected)
  };
  sock.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "cmd" && BG_ACTIONS.has(m.action)) { handleBgCommand(m); return; }
    sendToActiveTab(m);
  };
}
function advance() { pi = (pi + 1) % PORTS.length; }
function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1200); }
const connected = () => !!(ws && ws.readyState === 1);

function sendToServer(obj) { if (connected()) ws.send(JSON.stringify(obj)); }
function sendToActiveTab(m) { if (activeTabId != null) chrome.tabs.sendMessage(activeTabId, m).catch(() => {}); }
function pushStatus(on) { if (activeTabId != null) chrome.tabs.sendMessage(activeTabId, { t: "ext_status", connected: on }).catch(() => {}); }

function handleBgCommand(m) {
  const reply = (result) => sendToServer({ t: "cmdreply", id: m.id, result });
  if (m.action === "list_tabs") { chrome.tabs.query({}, (tabs) => reply({ tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) })); return; }
  if (m.action === "open_tab") {
    const url = /^[a-z]+:\/\//i.test(m.params.url || "") ? m.params.url : "https://" + (m.params.url || "");
    chrome.tabs.create({ url, active: true }, (tab) => { activeTabId = tab.id; waitLoad(tab.id, () => reply({ ok: true, url })); });
    return;
  }
  if (m.action === "navigate") {
    if (activeTabId == null) return reply({ ok: false, error: "no active tab — open one first" });
    const url = /^[a-z]+:\/\//i.test(m.params.url || "") ? m.params.url : "https://" + (m.params.url || "");
    chrome.tabs.update(activeTabId, { url }, () => waitLoad(activeTabId, () => reply({ ok: true, url })));
    return;
  }
}
function waitLoad(tabId, done) {
  let fired = false;
  const finish = () => { if (fired) return; fired = true; try { chrome.tabs.onUpdated.removeListener(listener); } catch {} setTimeout(done, 400); };
  const listener = (tid, info) => { if (tid === tabId && info.status === "complete") finish(); };
  chrome.tabs.onUpdated.addListener(listener);
  setTimeout(finish, 9000);
}

// Keepalive: a connected port from the content script keeps this MV3 worker (and
// the WS) alive while any page with the panel is open.
chrome.runtime.onConnect.addListener((port) => {
  keepPorts.add(port);
  if (!connected()) connect();
  port.onDisconnect.addListener(() => keepPorts.delete(port));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.tab) activeTabId = sender.tab.id;
  if (msg.t === "register") { if (!connected()) connect(); reply({ connected: connected() }); return true; }
  if (msg.t === "to_server") { sendToServer(msg.payload); reply({ ok: true }); return true; }
  return false;
});

chrome.action.onClicked.addListener((tab) => { activeTabId = tab.id; chrome.tabs.sendMessage(tab.id, { t: "toggle_panel" }).catch(() => {}); });

connect();
