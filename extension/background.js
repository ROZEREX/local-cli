// Service worker: the ONLY part allowed to open a localhost WebSocket (content
// scripts are blocked by page CSP). Keeps one WS to ws://localhost:4317/ext and
// relays between the server and the active tab's content script. Also handles the
// "background" commands the agent can issue — opening/navigating tabs — itself.

const WS_URL = "ws://localhost:4317/ext";
const BG_ACTIONS = new Set(["open_tab", "navigate", "list_tabs"]);
let ws = null;
let activeTabId = null;
let reconnectTimer = null;

function connect() {
  try { ws = new WebSocket(WS_URL); } catch { scheduleReconnect(); return; }
  ws.onopen = () => pushStatus(true);
  ws.onclose = () => { ws = null; pushStatus(false); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "cmd" && BG_ACTIONS.has(m.action)) { handleBgCommand(m); return; }
    sendToActiveTab(m); // DOM commands + chat/ready/etc → the panel/content script
  };
}
function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1500); }
const connected = () => !!(ws && ws.readyState === 1);

function sendToServer(obj) { if (connected()) ws.send(JSON.stringify(obj)); }
function sendToActiveTab(m) { if (activeTabId != null) chrome.tabs.sendMessage(activeTabId, m).catch(() => {}); }
function pushStatus(on) { if (activeTabId != null) chrome.tabs.sendMessage(activeTabId, { t: "ext_status", connected: on }).catch(() => {}); }

// Open / navigate tabs on the user's behalf, then report back to the agent.
function handleBgCommand(m) {
  const reply = (result) => sendToServer({ t: "cmdreply", id: m.id, result });
  if (m.action === "list_tabs") {
    chrome.tabs.query({}, (tabs) => reply({ tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })) }));
    return;
  }
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
  let fired = false; const finish = () => { if (fired) return; fired = true; try { chrome.tabs.onUpdated.removeListener(listener); } catch {} setTimeout(done, 400); };
  const listener = (tid, info) => { if (tid === tabId && info.status === "complete") finish(); };
  chrome.tabs.onUpdated.addListener(listener);
  setTimeout(finish, 9000); // fallback if 'complete' never fires
}

// Messages from content scripts. Crucially, "register" lets a freshly-loaded tab
// announce itself so we know where to forward server messages + report status.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.tab) activeTabId = sender.tab.id;
  if (msg.t === "register") { reply({ connected: connected() }); return true; }
  if (msg.t === "to_server") { sendToServer(msg.payload); reply({ ok: true }); return true; }
  return false;
});

chrome.action.onClicked.addListener((tab) => { activeTabId = tab.id; chrome.tabs.sendMessage(tab.id, { t: "toggle_panel" }).catch(() => {}); });

connect();
