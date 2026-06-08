// Bridge between the agent and the browser EXTENSION. The extension (a content
// script on the user's live page) connects to the web server over a WebSocket;
// this module lets the agent's page_* tools send it commands — read the page,
// move the AI cursor, highlight, click — and await the result the extension
// reports back after executing them in the real tab. Only one extension page is
// active at a time (the focused tab that opened the panel).

type Sender = (obj: any) => void;

let sender: Sender | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();

// The web server calls this when an extension connects (with a send fn) or
// disconnects (null). On disconnect, any in-flight commands fail cleanly.
export function setExtension(send: Sender | null): void {
  sender = send;
  if (!send) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("the browser extension disconnected")); }
    pending.clear();
  }
}

export function extensionConnected(): boolean { return !!sender; }

// The web server calls this when the extension reports a command result.
export function resolveCommand(id: number, result: any): void {
  const p = pending.get(id);
  if (p) { clearTimeout(p.timer); pending.delete(id); p.resolve(result); }
}

// Send a command to the extension and await its result (executed in the page).
export function sendCommand(action: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!sender) return reject(new Error("No browser extension connected. Open the local-cli extension panel on a page first."));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`page ${action} timed out`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    sender({ t: "cmd", id, action, params });
  });
}
