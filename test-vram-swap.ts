// Tests the automatic VRAM swap around image generation. The decision has to be
// measured, not assumed: on a 24 GB card an LLM and SDXL usually coexist, so an
// unnecessary unload is a slow regression for nothing — while a real shortage
// that goes unhandled means an OOM or a crawl.
import "./test-config-setup";
import { saveConfig } from "./src/config";
import { estimateImageVramMB, vramSnapshot, freeVramForImage, unloadOllamaModel } from "./src/vram";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// Mock Ollama: /api/ps reports residency, /api/generate with keep_alive 0 evicts.
let resident: { name: string; size_vram: number }[] = [];
let unloadCalls: string[] = [];

const ollama = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/ps") return Response.json({ models: resident });
    if (p === "/api/generate") {
      const b: any = await req.json().catch(() => ({}));
      if (b.keep_alive === 0) { unloadCalls.push(b.model); resident = resident.filter(m => m.name !== b.model); }
      return Response.json({ done: true });
    }
    if (p === "/api/chat") return Response.json({ done: true });
    if (p === "/api/version") return Response.json({ version: "0.1.0" });
    return new Response("nf", { status: 404 });
  },
});

const GB = 1024;

const run = async () => {
  saveConfig({ baseUrl: `http://localhost:${ollama.port}/v1`, model: "qwen3.5:9b", apiKey: "t" });

  // ── VRAM estimates scale with pixels ────────────────────────────────────
  check("512² needs less than 768²", estimateImageVramMB(512, 512) < estimateImageVramMB(768, 768));
  check("768² needs less than 1024²", estimateImageVramMB(768, 768) < estimateImageVramMB(1024, 1024));
  check("1024² estimate is in a sane range (8-12 GB)", estimateImageVramMB(1024, 1024) >= 8 * GB && estimateImageVramMB(1024, 1024) <= 12 * GB);

  // ── live snapshot on this machine ───────────────────────────────────────
  const snap = vramSnapshot();
  check("reads live VRAM via nvidia-smi", snap.source === "nvidia-smi" && snap.totalMB > 0, JSON.stringify(snap));
  check("this box reports a 24 GB card", snap.totalMB >= 24000 && snap.totalMB < 25600, `total=${snap.totalMB}MB`);
  check("free + used accounts for the card", Math.abs(snap.freeMB + snap.usedMB - snap.totalMB) < 2000);

  // ── "never" is a strict no-op ───────────────────────────────────────────
  resident = [{ name: "qwen3.5:9b", size_vram: 7 * GB * 1024 * 1024 }];
  unloadCalls = [];
  const never = await freeVramForImage(1024, 1024, "never");
  check("mode never: unloads nothing", unloadCalls.length === 0 && never.unloaded.length === 0);
  check("mode never: explains itself", never.reason.includes("off"));

  // ── "always" evicts regardless of headroom ──────────────────────────────
  resident = [{ name: "qwen3.5:9b", size_vram: 7 * GB * 1024 * 1024 }];
  unloadCalls = [];
  const always = await freeVramForImage(512, 512, "always");
  check("mode always: evicts the resident model", unloadCalls.includes("qwen3.5:9b"));
  check("mode always: reports what it unloaded", always.unloaded.includes("qwen3.5:9b"));
  check("mode always: flagged as a swap", always.needed);

  // ── "always" with nothing loaded is graceful ────────────────────────────
  resident = [];
  unloadCalls = [];
  const nothing = await freeVramForImage(512, 512, "always");
  check("mode always: no-op when nothing is resident", unloadCalls.length === 0 && nothing.reason.includes("Nothing is loaded"));

  // ── "auto" on this real 24 GB card ──────────────────────────────────────
  // The point of auto: a small image with plenty free must NOT evict.
  resident = [{ name: "qwen3.5:9b", size_vram: 7 * GB * 1024 * 1024 }];
  unloadCalls = [];
  const live = vramSnapshot();
  const smallNeed = estimateImageVramMB(512, 512);
  const auto = await freeVramForImage(512, 512, "auto");
  if (live.freeMB >= smallNeed + 1024) {
    check("mode auto: does NOT evict when there's room", unloadCalls.length === 0, auto.reason);
    check("mode auto: says why it left the LLM alone", auto.reason.includes("no need to unload"), auto.reason);
  } else {
    check("mode auto: evicts when VRAM is genuinely short", unloadCalls.includes("qwen3.5:9b"), auto.reason);
  }

  // ── unload helper reports failure honestly ──────────────────────────────
  saveConfig({ baseUrl: "http://127.0.0.1:1/v1" });
  check("unload returns false when Ollama is unreachable", (await unloadOllamaModel("x")) === false);
  const noHost = await freeVramForImage(1024, 1024, "always");
  check("unreachable Ollama does not claim a successful unload", noHost.unloaded.length === 0);

  ollama.stop(true);
  console.log(`\n${fail === 0 ? "VRAM-SWAP OK" : "VRAM-SWAP FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
