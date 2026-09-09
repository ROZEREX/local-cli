// End-to-end contract test for the browser transport. It launches the real
// web server with a throwaway config directory and a tiny mock Ollama backend,
// so this never reads or writes the user's config, chats, or running model.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const root = import.meta.dir;
const scratch = mkdtempSync(join(tmpdir(), "lcli-web-protocol-"));
const configDir = join(scratch, "config");
mkdirSync(configDir, { recursive: true });

// A delayed first token gives the StreamWatchdog time to emit a heartbeat.
// The same delay also leaves a deterministic window in which to interrupt a
// second turn and verify its terminal outcome.
const modelServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/version") return Response.json({ version: "test" });
    if (url.pathname === "/api/tags") {
      return Response.json({ models: [{ name: "web-contract-model", size: 1_000_000, details: { family: "test" } }] });
    }
    if (url.pathname === "/api/show") {
      return Response.json({
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "test", "test.context_length": 8192 },
      });
    }
    if (url.pathname === "/api/ps") {
      return Response.json({ models: [{ name: "web-contract-model", size: 1_000_000, size_vram: 1_000_000, context_length: 8192 }] });
    }
    if (url.pathname === "/api/chat") {
      const body: any = await req.json().catch(() => ({}));
      // warmUp() sends an empty message list and does not request a stream.
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return Response.json({ message: { content: "" }, done: true });
      }
      await Bun.sleep(260);
      const last = body.messages.at(-1);
      const asksForTool = [...body.messages].reverse().find((message: any) => message.role === "user")?.content?.includes("protocol tool test");
      let ndjson: string;
      if (last?.role === "tool") {
        ndjson =
          JSON.stringify({ message: { content: "Tool protocol complete." }, done: false }) + "\n" +
          JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 17, eval_count: 5, eval_duration: 1_000_000_000 }) + "\n";
      } else if (asksForTool) {
        ndjson = JSON.stringify({
          message: { content: "", tool_calls: [{ id: "mock_read_call", function: { name: "read_file", arguments: { path: "package.json" } } }] },
          done: true, prompt_eval_count: 13, eval_count: 3, eval_duration: 1_000_000_000,
        }) + "\n";
      } else {
        ndjson =
          JSON.stringify({ message: { content: "Protocol test reply." }, done: false }) + "\n" +
          JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 11, eval_count: 4, eval_duration: 1_000_000_000 }) + "\n";
      }
      return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  },
});

writeFileSync(join(configDir, "config.json"), JSON.stringify({
  baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
  apiKey: "test",
  provider: "ollama",
  model: "web-contract-model",
  models: ["web-contract-model"],
  cwd: root,
  contextWindow: 8192,
  maxTokens: 128,
  maxIterations: 3,
  temperature: 0,
  thinking: false,
  toolMode: "native",
  mode: "normal",
  stallHeartbeatSec: 0.05,
  stallTimeoutSec: 5,
}, null, 2));

// Reserve a loopback port briefly, then hand it to the child. This avoids a
// hard-coded port colliding with a developer's running web UI.
const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
const port = reservation.port;
reservation.stop(true);

const child = Bun.spawn({
  cmd: [process.execPath, "run", "ui-web/server.ts"],
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    LOCAL_CLI_CONFIG_DIR: configDir,
    NO_COLOR: "1",
  },
  stdout: "pipe",
  stderr: "pipe",
});

const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

async function waitForBootstrap(): Promise<Response> {
  let last = "server did not answer";
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      if (response.status < 500) return response;
      last = `HTTP ${response.status}`;
    } catch (error: any) {
      last = String(error?.message ?? error);
    }
    await Bun.sleep(50);
  }
  const stderr = child.exitCode !== null
    ? await new Response(child.stderr).text().catch(() => "")
    : "";
  throw new Error(`web server did not start (${last})${stderr ? `\n${stderr}` : ""}`);
}

type Predicate = (message: any) => boolean;

interface TestSocket {
  socket: WebSocket;
  messages: any[];
  next: (predicate: Predicate, timeoutMs?: number, since?: number) => Promise<any>;
  close: () => Promise<void>;
}

async function connectSocket(url: string, origin: string): Promise<TestSocket> {
  const socket = new WebSocket(url, { headers: { Origin: origin } } as any);
  const messages: any[] = [];
  const waiters = new Set<{ predicate: Predicate; resolve: (value: any) => void; reject: (reason: Error) => void; since: number; timer: ReturnType<typeof setTimeout> }>();

  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (messages.length - 1 >= waiter.since && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timed out")), 3000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("websocket upgrade was rejected")); };
  });

  return {
    socket,
    messages,
    next(predicate, timeoutMs = 5000, since = 0) {
      const existing = messages.slice(since).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter: any = { predicate, resolve, reject, since };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for websocket event; received: ${messages.slice(since).map(m => m.t).join(", ")}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        socket.onclose = () => { clearTimeout(timer); resolve(); };
        socket.close(1000, "test complete");
      });
    },
  };
}

async function upgradeRejected(url: string, origin?: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let opened = false;
    let settled = false;
    const headers = origin ? { Origin: origin } : {};
    const socket = new WebSocket(url, { headers } as any);
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(!opened), 2000);
    socket.onopen = () => { opened = true; done(false); };
    socket.onerror = () => done(!opened);
    socket.onclose = () => done(!opened);
  });
}

function hasEnvelope(message: any): boolean {
  return typeof message?.runId === "string" && message.runId.length >= 8
    && Number.isInteger(message?.seq) && message.seq >= 0
    && typeof message?.at === "number" && Number.isFinite(message.at);
}

let a2: TestSocket | null = null;
let b: TestSocket | null = null;
let ext: TestSocket | null = null;

try {
  const bootstrapResponse = await waitForBootstrap();
  const bootstrap: any = await bootstrapResponse.json().catch(() => ({}));
  const token = bootstrap.token;

  check("bootstrap returns a high-entropy capability token", typeof token === "string" && token.length >= 32, JSON.stringify(bootstrap));
  check("bootstrap response cannot be cached", /no-store/i.test(bootstrapResponse.headers.get("cache-control") ?? ""), bootstrapResponse.headers.get("cache-control") ?? "missing header");
  check("bootstrap does not grant cross-origin reads", !bootstrapResponse.headers.has("access-control-allow-origin"));
  const crossSiteBootstrap = await fetch(`${base}/api/bootstrap`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  check("bootstrap rejects an explicitly cross-site browser request", crossSiteBootstrap.status === 403, `HTTP ${crossSiteBootstrap.status}`);
  const bootstrapPost = await fetch(`${base}/api/bootstrap`, { method: "POST" });
  check("bootstrap is GET-only", bootstrapPost.status === 405, `HTTP ${bootstrapPost.status}`);
  const rebound = await fetch(`${base}/api/bootstrap`, { headers: { Host: "evil.example" } });
  check("HTTP rejects a non-loopback Host", rebound.status === 421, `HTTP ${rebound.status}`);
  const traversal = await fetch(`${base}/..%2fpackage.json`);
  check("static file route blocks encoded parent traversal", traversal.status === 404, `HTTP ${traversal.status}`);

  const unauthenticated = await fetch(`${base}/api/config`);
  check("REST rejects a missing token", unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);
  const wrongToken = await fetch(`${base}/api/config`, { headers: { "X-Local-CLI-Token": "wrong" } });
  check("REST rejects an invalid token", wrongToken.status === 401, `HTTP ${wrongToken.status}`);
  const authenticated = await fetch(`${base}/api/config`, { headers: { "X-Local-CLI-Token": token } });
  check("REST accepts X-Local-CLI-Token", authenticated.ok, `HTTP ${authenticated.status}`);

  const noTokenUrl = `${wsBase}/ws?clientId=${crypto.randomUUID()}`;
  check("websocket rejects a missing token", await upgradeRejected(noTokenUrl, base));
  const wrongOriginUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}&clientId=${crypto.randomUUID()}`;
  check("websocket rejects a foreign Origin", await upgradeRejected(wrongOriginUrl, "https://evil.example"));
  check("websocket rejects a missing Origin", await upgradeRejected(wrongOriginUrl));

  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const extNoToken = `${wsBase}/ext?clientId=${crypto.randomUUID()}`;
  check("extension bridge rejects a missing token", await upgradeRejected(extNoToken, extensionOrigin));
  check("extension bridge rejects an ordinary web origin", await upgradeRejected(`${wsBase}/ext?token=${encodeURIComponent(token)}&clientId=${crypto.randomUUID()}`, base));
  ext = await connectSocket(`${wsBase}/ext?token=${encodeURIComponent(token)}&clientId=${crypto.randomUUID()}`, extensionOrigin);
  const extReady = await ext.next(m => m.t === "ready");
  check("authenticated extension origin reaches only the extension bridge", extReady.ext === true, JSON.stringify(extReady));
  await ext.close();
  ext = null;

  const clientA = crypto.randomUUID();
  const a1 = await connectSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&clientId=${clientA}`, base);
  const readyA1 = await a1.next(m => m.t === "ready");
  check("ready identifies the resumable server session", typeof readyA1.sessionId === "string" && readyA1.sessionId.length > 0, JSON.stringify(readyA1));
  await a1.close();
  await Bun.sleep(40);

  a2 = await connectSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&clientId=${clientA}`, base);
  const readyA2 = await a2.next(m => m.t === "ready");
  check("same clientId reconnects to the same session", readyA2.sessionId === readyA1.sessionId, `${readyA1.sessionId} -> ${readyA2.sessionId}`);

  const clientB = crypto.randomUUID();
  b = await connectSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&clientId=${clientB}`, base);
  const readyB = await b.next(m => m.t === "ready");
  check("different clientIds have isolated sessions", readyB.sessionId !== readyA2.sessionId, `${readyA2.sessionId} vs ${readyB.sessionId}`);

  // Completed run: verify honest lifecycle telemetry and a single terminal event.
  const completedFrom = a2.messages.length;
  a2.socket.send(JSON.stringify({ t: "chat", text: "protocol completion test" }));
  const runStart = await a2.next(m => m.t === "run_start", 5000, completedFrom);
  const completed = await a2.next(m => m.t === "run_end" && m.runId === runStart.runId, 8000, completedFrom);
  const completedEvents = a2.messages.slice(completedFrom).filter(m => m.runId === runStart.runId);
  const heartbeat = completedEvents.find(m => m.t === "heartbeat");
  const phase = completedEvents.find(m => m.t === "phase");
  const usage = completedEvents.find(m => m.t === "usage");

  check("run_start has the typed event envelope", hasEnvelope(runStart), JSON.stringify(runStart));
  check("run-scoped event sequence is strictly increasing", completedEvents.every((m, i) => hasEnvelope(m) && (i === 0 || m.seq > completedEvents[i - 1]!.seq)), JSON.stringify(completedEvents.map(m => [m.t, m.seq])));
  check("run reports a concrete loading/prefill/output phase", !!phase && ["loading", "prefill", "reasoning", "answer"].includes(phase.phase), JSON.stringify(phase));
  check("slow prefill is an ephemeral heartbeat event", !!heartbeat && typeof heartbeat.message === "string" && typeof heartbeat.elapsedSec === "number", JSON.stringify(heartbeat));
  check("heartbeat is not duplicated into transcript notices", !completedEvents.some(m => m.t === "notice" && /still (working|waiting)/i.test(String(m.v ?? m.message ?? ""))));
  check("usage includes real input/output/speed numbers", !!usage
    && typeof (usage.inputTokens ?? usage.inTok) === "number"
    && typeof (usage.outputTokens ?? usage.outTok) === "number"
    && typeof (usage.tokPerSec ?? usage.tps) === "number", JSON.stringify(usage));
  check("completed turn has one terminal event", completedEvents.filter(m => m.t === "run_end").length === 1 && completed.outcome === "completed", JSON.stringify(completed));
  check("terminal event includes elapsed time", typeof completed.durationMs === "number" && completed.durationMs >= 0, JSON.stringify(completed));

  // Cancelled run: the outcome must be explicit and terminal exactly once.
  const cancelledFrom = a2.messages.length;
  a2.socket.send(JSON.stringify({ t: "chat", text: "protocol cancellation test" }));
  const cancelStart = await a2.next(m => m.t === "run_start" && m.runId !== runStart.runId, 5000, cancelledFrom);
  a2.socket.send(JSON.stringify({ t: "interrupt", runId: cancelStart.runId }));
  const cancelled = await a2.next(m => m.t === "run_end" && m.runId === cancelStart.runId, 8000, cancelledFrom);
  const cancelledEvents = a2.messages.slice(cancelledFrom).filter(m => m.runId === cancelStart.runId);
  check("each turn receives a distinct runId", cancelStart.runId !== runStart.runId);
  check("interrupt produces an explicit cancelled outcome", cancelled.outcome === "cancelled", JSON.stringify(cancelled));
  check("cancelled turn has one terminal event", cancelledEvents.filter(m => m.t === "run_end").length === 1, JSON.stringify(cancelledEvents.map(m => m.t)));
  check("cancelled run sequence remains monotonic", cancelledEvents.every((m, i) => hasEnvelope(m) && (i === 0 || m.seq > cancelledEvents[i - 1]!.seq)), JSON.stringify(cancelledEvents.map(m => [m.t, m.seq])));

  // Read-only tool run: call/result correlation must not depend on tool names,
  // because multiple calls to the same tool may be in flight concurrently.
  const toolFrom = b.messages.length;
  b.socket.send(JSON.stringify({ t: "chat", text: "protocol tool test" }));
  const toolStart = await b.next(m => m.t === "run_start", 5000, toolFrom);
  const toolEnd = await b.next(m => m.t === "run_end" && m.runId === toolStart.runId, 10_000, toolFrom);
  const toolEvents = b.messages.slice(toolFrom).filter(m => m.runId === toolStart.runId);
  const toolCall = toolEvents.find(m => m.t === "tool_call");
  const toolResult = toolEvents.find(m => m.t === "tool_result");
  const toolPhase = toolEvents.find(m => m.t === "tool_progress" && m.phase === "running");
  check("tool call has a stable call ID", typeof toolCall?.toolId === "string" && toolCall.toolId.length > 0, JSON.stringify(toolCall));
  check("tool result correlates by call ID", !!toolResult && toolResult.toolId === toolCall?.toolId, JSON.stringify(toolResult));
  check("tool result includes execution duration", typeof toolResult?.durationMs === "number" && toolResult.durationMs >= 0, JSON.stringify(toolResult));
  check("tool execution emits an explicit correlated running phase", !!toolPhase && toolPhase.toolId === toolCall?.toolId, JSON.stringify(toolEvents.map(m => [m.t, m.phase, m.toolId])));
  check("tool lifecycle order is explicit", toolCall?.seq < toolResult?.seq && toolResult?.seq < toolEnd.seq, JSON.stringify(toolEvents.map(m => [m.t, m.seq])));
  check("terminal event reports the tool count", toolEnd.outcome === "completed" && toolEnd.toolCount === 1, JSON.stringify(toolEnd));
} catch (error: any) {
  fail++;
  console.error(`  ✗ protocol test setup/runtime — ${error?.stack ?? error}`);
} finally {
  await a2?.close().catch(() => {});
  await b?.close().catch(() => {});
  await ext?.close().catch(() => {});
  child.kill();
  await child.exited.catch(() => {});
  modelServer.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "WEB PROTOCOL OK" : "WEB PROTOCOL FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
