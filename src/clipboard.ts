import { platform } from "os";

// Strip anything that could corrupt the terminal when rendered back: ANSI/CSI
// escape sequences (including bracketed-paste markers ESC[200~ / ESC[201~ and
// the charset-select escapes that change the terminal font), OSC/DCS strings,
// and C0 control bytes. Keep newlines; turn tabs into spaces. This is applied to
// everything inserted into the input, so pasted text can never emit escapes.
export function sanitizeForInput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")          // CSI (incl. bracketed paste)
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")               // charset selection (the "font" change)
    .replace(/\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\)/g, "")// OSC / DCS / APC / PM / SOS
    .replace(/\x1b./g, "")                               // any leftover ESC pair
    .replace(/\t/g, "  ")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");   // other control bytes (keep \n)
}

// Read the system clipboard. Used for Ctrl+V paste, because terminals in raw
// mode deliver Ctrl+V as a control byte (0x16) rather than the clipboard text.
export async function readClipboard(): Promise<string> {
  const cmd =
    platform() === "darwin" ? ["pbpaste"] :
    platform() === "win32" ? ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"] :
    ["xclip", "-selection", "clipboard", "-o"];

  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // Normalize newlines and trim the single trailing newline these tools add.
    return text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  } catch {
    return "";
  }
}
