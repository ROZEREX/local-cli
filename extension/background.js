// Service worker: the ONLY part that talks to the local-cli web server (a content
// script can't open a localhost WebSocket because of page CSP). It keeps one WS to
// ws://localhost:4317/ext and relays messages to/from the active tab's content
// script via chrome.tabs messaging.

const WS_URL = "ws://localhost:4317/ext";
let ws = null;
let activeTabId = null;
let reconnectTimer = null;

function connect() {
  try { ws = new WebSocket(WS_URL); } catch { scheduleReconnect(); return; }
  ws.onopen = () => { broadcast({ t: "ext_status", connected: true }); };
  ws.onclose = () => { ws = null; broadcast({ t: "ext_status", connected: false }); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    // Forward every server message to the active tab's panel.
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    sendToActiveTab(m);
  };
}
function scheduleReconnect() { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1500); }

function sendToServer(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendToActiveTab(m) { if (activeTabId != null) chrome.tabs.sendMessage(activeTabId, m).catch(() => {}); }
function broadcast(m) { sendToActiveTab(m); }

// Messages from a content script (user chat, command results, panel open).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.tab) activeTabId = sender.tab.id;
  if (msg.t === "to_server") { sendToServer(msg.payload); reply({ ok: true }); return true; }
  if (msg.t === "want_status") { reply({ connected: !!(ws && ws.readyState === 1) }); return true; }
  return false;
});

// Toolbar click → tell the active tab to toggle the panel.
chrome.action.onClicked.addListener((tab) => { activeTabId = tab.id; chrome.tabs.sendMessage(tab.id, { t: "toggle_panel" }).catch(() => {}); });

connect();
