// Verifies the per-turn status phases (loading → prefill → generating) and the
// one-time VRAM spill warning sourced from Ollama's /api/ps. Mocks /api/version,
// /api/show, /api/ps and /api/chat (NDJSON).
import "./test-config-setup";
import { chat, resetClient } from "./src/llm";
import { saveConfig } from "./src/config";
import { loadedModels } from "./src/ollama";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

// First /api/ps call: model not loaded (cold start). After that: loaded, but
// only 60% of it fits on the GPU (the spill case).
let psCalls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/api/version")) return Response.json({ version: "test" });
    if (path.endsWith("/api/show")) return Response.json({ capabilities: ["completion"] });
    if (path.endsWith("/api/ps")) {
      psCalls++;
      if (psCalls === 1) return Response.json({ models: [] });
      return Response.json({ models: [{ name: "mock", size: 10_000_000_000, size_vram: 6_000_000_000, expires_at: "2099-01-01T00:00:00Z" }] });
    }
    if (path.endsWith("/api/chat")) {
      const ndjson =
        JSON.stringify({ message: { content: "Hi" }, done: false }) + "\n" +
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 2, eval_duration: 1_000_000_000 }) + "\n";
      return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("nf", { status: 404 });
  },
});

saveConfig({ baseUrl: `http://localhost:${server.port}/v1`, apiKey: "t", model: "mock", toolMode: "auto", cwd: process.cwd() });
resetClient();

// loadedModels parses /api/ps (the second response shape).
await loadedModels(`http://localhost:${server.port}/v1`); // consume the cold-start response
const loaded = await loadedModels(`http://localhost:${server.port}/v1`);
check("loadedModels parses /api/ps", loaded.length === 1 && loaded[0]!.name === "mock");
check("loadedModels maps size_vram", loaded[0]!.size === 10_000_000_000 && loaded[0]!.sizeVram === 6_000_000_000);
psCalls = 0; // reset so the chat turns below see cold → loaded again

const phases: string[] = [];
const notices: string[] = [];
const cb = {
  onText: () => {}, onToolCall: () => {}, onToolResult: () => {},
  onError: () => { fail++; },
  onNotice: (v: string) => notices.push(v),
  onStatus: (p: string) => phases.push(p),
  requestPermission: async () => true,
};

// Turn 1: /api/ps says the model is NOT loaded → "loading" phase first.
await chat([{ role: "system", content: "s" }, { role: "user", content: "hi" }], cb as any);
check("cold start reports 'loading'", phases[0] === "loading", JSON.stringify(phases));
check("first token reports 'generating'", phases.includes("generating"), JSON.stringify(phases));

// Turn 2: model loaded but spilled → "prefill" phase + one VRAM notice.
phases.length = 0;
await chat([{ role: "system", content: "s" }, { role: "user", content: "hi again" }], cb as any);
check("warm start reports 'prefill'", phases[0] === "prefill", JSON.stringify(phases));
const vramNotices = notices.filter(n => /VRAM/.test(n));
check("VRAM spill notice fired", vramNotices.length === 1, JSON.stringify(notices));
check("notice names the GPU share", /60%/.test(vramNotices[0] ?? ""), vramNotices[0] ?? "");
check("notice gives concrete advice", /context window/i.test(vramNotices[0] ?? ""));

// Turn 3: still spilled, but the notice must NOT repeat.
await chat([{ role: "system", content: "s" }, { role: "user", content: "third" }], cb as any);
check("VRAM notice fires only once per model", notices.filter(n => /VRAM/.test(n)).length === 1);

server.stop(true);
console.log(`\n${fail === 0 ? "STATUS-VRAM OK" : "STATUS-VRAM FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
