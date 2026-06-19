import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";
import { getConfig } from "./config";
import { modelCapabilities, listOllamaModelsDetailed, modelInfo, isOllama } from "./ollama";

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

// Send an image (base64 PNG) + a question to the vision model. Supports Ollama's native
// /api/chat or standard OpenAI-compatible /v1/chat/completions. Returns description.
export async function analyzeImage(base64: string, question: string): Promise<string> {
  const cfg = getConfig();
  const host = cfg.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  const isOll = await isOllama(cfg.baseUrl).catch(() => false);

  const isExplicitVisionModel = (name: string) => /vl|llava|vision|minicpm|paligemma|internvl|mplug/i.test(name);

  let visionModel = cfg.model;
  let activeHasVision = false;

  if (isOll) {
    // 1. First check if the active model itself is explicitly a vision model or has capability
    activeHasVision = isExplicitVisionModel(cfg.model);
    if (!activeHasVision) {
      try {
        const activeCaps = await modelCapabilities(cfg.baseUrl, cfg.model);
        if (activeCaps.includes("vision")) {
          activeHasVision = true;
        }
      } catch {}
    }

    // 2. If active model is not vision, look for an installed model that is
    if (!activeHasVision) {
      try {
        const installed = await listOllamaModelsDetailed(cfg.baseUrl).catch(() => []);
        // Match by name first
        for (const m of installed) {
          if (isExplicitVisionModel(m.name)) {
            visionModel = m.name;
            activeHasVision = true;
            break;
          }
        }
        // Match by capability if name didn't match
        if (!activeHasVision) {
          for (const m of installed) {
            const info = await modelInfo(cfg.baseUrl, m.name).catch(() => null);
            if (info?.capabilities?.includes("vision")) {
              visionModel = m.name;
              activeHasVision = true;
              break;
            }
          }
        }
      } catch {}
    }

    if (!activeHasVision) {
      return `The current model (${cfg.model}) does not support vision. Please pull a vision model (e.g. 'ollama pull qwen2.5-vl' or 'ollama pull llava') so the agent can see screenshots and layout styling.`;
    }

    try {
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: visionModel,
          stream: false,
          messages: [{ role: "user", content: question || "Describe what is shown in detail. Note any errors, broken layout, or problems.", images: [base64] }],
          options: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) return `Vision request failed (${res.status}) on model "${visionModel}".`;
      const data: any = await res.json();
      const desc = (data.message?.content || "").trim();
      if (visionModel !== cfg.model) {
        return `[Analyzed using visual fallback model "${visionModel}"]: \n\n${desc}`;
      }
      return desc || "(the model returned no description)";
    } catch (e: any) {
      return `Vision request error: ${e.message}`;
    }
  } else {
    // Non-Ollama endpoint (OpenAI, Gemini, OpenRouter) - assume the active model has vision
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.apiKey && cfg.apiKey !== "ollama" && cfg.apiKey !== "test") {
        headers["Authorization"] = `Bearer ${cfg.apiKey}`;
      }
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: visionModel,
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: question || "Describe what is shown in detail. Note any errors, broken layout, or problems." },
                { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }
              ]
            }
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) return `Vision request failed (${res.status}) on model "${visionModel}".`;
      const data: any = await res.json();
      const desc = (data.choices?.[0]?.message?.content || "").trim();
      return desc || "(the model returned no description)";
    } catch (e: any) {
      return `Vision request error: ${e.message}`;
    }
  }
}
