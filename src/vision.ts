import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";
import { getConfig } from "./config";
import { modelCapabilities } from "./ollama";

// "See" the screen: capture an image and have a vision-capable model describe or
// analyze it. Powers the screenshot tool (desktop) and browser_screenshot's
// optional analysis, so the agent can look at what it built or what you're doing.

// Capture the primary screen as base64 PNG. Windows uses .NET via PowerShell;
// macOS uses screencapture; Linux tries scrot/import/gnome-screenshot.
export function captureDesktop(): string {
  const out = join(tmpdir(), `lcli-shot-${Date.now()}.png`);
  try {
    if (platform() === "win32") {
      const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
        `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
        `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ` +
        `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ` +
        `$bmp.Save(${JSON.stringify(out)}); $g.Dispose(); $bmp.Dispose();`;
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000 });
    } else if (platform() === "darwin") {
      spawnSync("screencapture", ["-x", out], { timeout: 15000 });
    } else {
      const tools: [string, string[]][] = [["scrot", [out]], ["import", ["-window", "root", out]], ["gnome-screenshot", ["-f", out]]];
      for (const [cmd, args] of tools) { try { const r = spawnSync(cmd, args, { timeout: 15000 }); if (r.status === 0 && existsSync(out)) break; } catch {} }
    }
    if (!existsSync(out)) throw new Error("screen capture produced no file");
    const b64 = readFileSync(out).toString("base64");
    try { unlinkSync(out); } catch {}
    return b64;
  } catch (e: any) {
    try { if (existsSync(out)) unlinkSync(out); } catch {}
    throw new Error(`Couldn't capture the screen: ${e.message}`);
  }
}

// Send an image (base64 PNG) + a question to the vision model via Ollama's native
// /api/chat (which accepts `images`). Returns the model's description.
export async function analyzeImage(base64: string, question: string): Promise<string> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const caps = await modelCapabilities(cfg.baseUrl, cfg.model);
  if (caps.length && !caps.includes("vision")) {
    return `The current model (${cfg.model}) can't see images (no "vision" capability). Switch to a vision model — e.g. one whose /modelinfo lists "vision", such as llava, a gemma3/4 vision build, or qwen2.5-vl — then try again.`;
  }
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [{ role: "user", content: question || "Describe what is shown in detail. Note any errors, broken layout, or problems.", images: [base64] }],
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return `Vision request failed (${res.status}). Make sure the model supports images.`;
    const data: any = await res.json();
    return (data.message?.content || "").trim() || "(the model returned no description)";
  } catch (e: any) {
    return `Vision request error: ${e.message}`;
  }
}
