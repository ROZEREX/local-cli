// Tests generate_image against a mock diffusion server. Verifies each backend
// protocol (A1111 / ComfyUI / SwarmUI), that the PNG actually lands on disk, and
// that a missing backend produces setup guidance rather than a bare error.
import "./test-config-setup";
import { saveConfig } from "./src/config";
import { generateImage, detectImageBackend, NO_BACKEND_MESSAGE } from "./src/imagegen";
import { generateImageTool } from "./src/tools/executor";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = "") => { c ? (pass++, console.log(`  ✓ ${l}`)) : (fail++, console.log(`  ✗ ${l} ${d}`)); };

// A 1×1 red PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

const dir = mkdtempSync(join(tmpdir(), "lcli-img-"));
let kind: "a1111" | "comfyui" | "swarmui" = "a1111";
let lastBody: any = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ── A1111 ──
    if (p === "/sdapi/v1/options") return kind === "a1111" ? Response.json({}) : new Response("nf", { status: 404 });
    if (p === "/sdapi/v1/txt2img") {
      lastBody = body;
      return Response.json({ images: [PNG_B64], info: JSON.stringify({ seed: 4242 }) });
    }

    // ── ComfyUI ──
    if (p === "/system_stats") return kind === "comfyui" ? Response.json({ system: {} }) : new Response("nf", { status: 404 });
    if (p === "/object_info/CheckpointLoaderSimple") {
      return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd_xl_base.safetensors"]] } } } });
    }
    if (p === "/prompt") { lastBody = body; return Response.json({ prompt_id: "pid-1" }); }
    if (p === "/history/pid-1") {
      return Response.json({ "pid-1": { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
    }
    if (p === "/view") return new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });

    // ── SwarmUI ──
    if (p === "/API/GetNewSession") return kind === "swarmui" ? Response.json({ session_id: "s1" }) : new Response("nf", { status: 404 });
    if (p === "/API/GenerateText2Image") { lastBody = body; return Response.json({ images: [`data:image/png;base64,${PNG_B64}`] }); }

    return new Response("nf", { status: 404 });
  },
});

const base = `http://127.0.0.1:${server.port}`;

const run = async () => {
  saveConfig({ cwd: dir, imageBaseUrl: base, imageDir: join(dir, "imgs") } as any);

  // ── A1111 ──
  kind = "a1111";
  const d1 = await detectImageBackend();
  check("detects an A1111-compatible server", d1?.kind === "a1111", JSON.stringify(d1));

  const r1 = await generateImage({ prompt: "a red square", width: 512, height: 512, steps: 8, cfgScale: 2, negativePrompt: "blurry" });
  check("A1111: wrote the PNG to disk", existsSync(r1.path));
  check("A1111: file is a real PNG", readFileSync(r1.path).subarray(1, 4).toString() === "PNG");
  check("A1111: reports the seed the server returned", r1.seed === 4242);
  check("A1111: passed the prompt through", lastBody.prompt === "a red square");
  check("A1111: passed the negative prompt", lastBody.negative_prompt === "blurry");
  check("A1111: honoured width/steps/cfg", lastBody.width === 512 && lastBody.steps === 8 && lastBody.cfg_scale === 2);
  check("A1111: default output path lands in imageDir", r1.path.includes("imgs"));

  // ── ComfyUI ──
  kind = "comfyui";
  const d2 = await detectImageBackend();
  check("detects ComfyUI", d2?.kind === "comfyui", JSON.stringify(d2));
  const r2 = await generateImage({ prompt: "a blue circle", seed: 99 });
  check("ComfyUI: wrote the PNG to disk", existsSync(r2.path));
  check("ComfyUI: used the discovered checkpoint", lastBody.prompt["4"].inputs.ckpt_name === "sd_xl_base.safetensors");
  check("ComfyUI: put the prompt in the positive CLIP node", lastBody.prompt["6"].inputs.text === "a blue circle");
  check("ComfyUI: honoured an explicit seed", lastBody.prompt["3"].inputs.seed === 99);

  // ── SwarmUI ──
  kind = "swarmui";
  const d3 = await detectImageBackend();
  check("detects SwarmUI", d3?.kind === "swarmui", JSON.stringify(d3));
  const r3 = await generateImage({ prompt: "a green triangle" });
  check("SwarmUI: wrote the PNG to disk", existsSync(r3.path));
  check("SwarmUI: sent the session id", lastBody.session_id === "s1");

  // ── explicit output path ──
  kind = "a1111";
  const r4 = await generateImage({ prompt: "logo", outPath: "assets/logo.png" });
  check("honours an explicit relative output path", r4.path === join(dir, "assets", "logo.png") && existsSync(r4.path));

  // ── the tool wrapper ──
  const out = await generateImageTool({ prompt: "icon", path: "assets/icon.png" });
  check("tool reports where it saved the file", out.includes("saved it to") && out.includes("icon.png"));
  check("tool result names the backend", out.includes("AUTOMATIC1111"));
  const empty = await generateImageTool({ prompt: "  " });
  check("tool rejects an empty prompt", empty.startsWith("Error: a prompt is required"));

  // ── no backend running ──
  saveConfig({ imageBaseUrl: "http://127.0.0.1:1" } as any);
  check("no backend detected when nothing is listening", (await detectImageBackend()) === null);
  const failMsg = await generateImageTool({ prompt: "anything" });
  check("missing backend explains how to set one up", failMsg.includes("No local image-generation server is running"));
  check("setup message names ComfyUI and A1111", NO_BACKEND_MESSAGE.includes("ComfyUI") && NO_BACKEND_MESSAGE.includes("AUTOMATIC1111"));
  check("setup message warns about VRAM contention", NO_BACKEND_MESSAGE.includes("VRAM"));

  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "IMAGEGEN OK" : "IMAGEGEN FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
