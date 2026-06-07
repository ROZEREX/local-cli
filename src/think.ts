// Streaming tag splitter. Models wrap special regions inside paired tags within
// the normal content channel — reasoning in <think>...</think>, and (for models
// without native tools) tool calls in <tool_call>...</tool_call>. This consumes
// raw chunks and yields segments marked inside/outside the region, correctly
// handling tags that straddle chunk boundaries by holding back a small tail.

export interface TagSegment {
  text: string;
  inside: boolean;
}

export class TagSplitter {
  private inside = false;
  private buffer = "";
  private readonly open: string;
  private readonly close: string;
  private readonly maxTag: number;

  constructor(open: string, close: string) {
    this.open = open;
    this.close = close;
    this.maxTag = Math.max(open.length, close.length);
  }

  push(chunk: string): TagSegment[] {
    this.buffer += chunk;
    const segments: TagSegment[] = [];

    while (true) {
      const marker = this.inside ? this.close : this.open;
      const idx = this.buffer.indexOf(marker);
      if (idx === -1) break;

      const before = this.buffer.slice(0, idx);
      if (before) segments.push({ text: before, inside: this.inside });
      this.buffer = this.buffer.slice(idx + marker.length);
      this.inside = !this.inside;
    }

    // No complete marker remains. Hold back only a trailing partial-tag prefix:
    // find the last '<' and, if the text from there could grow into a tag, keep
    // it buffered for the next chunk. Emit everything before it.
    const lastLt = this.buffer.lastIndexOf("<");
    let holdFrom = this.buffer.length;
    if (lastLt !== -1 && this.buffer.length - lastLt < this.maxTag) {
      const tail = this.buffer.slice(lastLt);
      if (this.open.startsWith(tail) || this.close.startsWith(tail)) holdFrom = lastLt;
    }

    if (holdFrom > 0) {
      segments.push({ text: this.buffer.slice(0, holdFrom), inside: this.inside });
      this.buffer = this.buffer.slice(holdFrom);
    }

    return segments;
  }

  flush(): TagSegment[] {
    if (!this.buffer) return [];
    const seg = { text: this.buffer, inside: this.inside };
    this.buffer = "";
    return [seg];
  }
}

// Detects a DEGENERATE generation loop — the same block of text repeated
// back-to-back many times (e.g. a model emitting the identical paragraph for
// thousands of tokens). Deliberately conservative: it only trips on consecutive
// verbatim repetition that has consumed a lot of output, so ordinary verbose
// answers (which may reuse a phrase here and there, or restate a plan once or
// twice) are NEVER cut off. False positives break real work, so we bias hard
// toward leaving generation alone.
export class RepetitionGuard {
  private buf = "";
  private lines: string[] = [];
  private _tripped = false;

  // reps: how many consecutive identical copies of a block before we call it a
  // loop. chars: that repetition must also total at least this many characters.
  constructor(private reps = 4, private chars = 800) {}

  // Returns true once a loop is detected.
  push(text: string): boolean {
    if (this._tripped) return true;
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      this.record(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      if (this._tripped) return true;
    }
    // Models that stream without newlines: treat a very long line-less run as a
    // unit so we can still notice a stuck loop.
    if (this.buf.length > 2000) { this.record(this.buf); this.buf = ""; }
    return this._tripped;
  }

  private record(rawLine: string): void {
    this.lines.push(rawLine.replace(/\s+/g, " ").trim());
    if (this.lines.length > 300) this.lines.shift();
    this.detect();
  }

  // Trip only if the most recent lines are a block repeated `reps`+ times in a
  // row, and that repetition spans at least `chars` characters.
  private detect(): void {
    const L = this.lines;
    const n = L.length;
    const maxCycle = Math.min(40, Math.floor(n / this.reps));
    for (let c = 1; c <= maxCycle; c++) {
      // Count consecutive copies of the last c-line block.
      let copies = 1;
      while ((copies + 1) * c <= n) {
        let same = true;
        for (let i = 0; i < c; i++) {
          if (L[n - 1 - i] !== L[n - 1 - i - copies * c]) { same = false; break; }
        }
        if (!same) break;
        copies++;
      }
      if (copies >= this.reps) {
        let blockChars = 0;
        for (let i = 0; i < c; i++) blockChars += L[n - 1 - i]!.length;
        if (blockChars >= 20 && blockChars * copies >= this.chars) { this._tripped = true; return; }
      }
    }
  }

  get tripped(): boolean { return this._tripped; }
}

// Strips "harmony" channel control tokens that some models (gemma, gpt-oss) emit
// inline — <|channel|>analysis<|message|>…<|end|>, <|start|>, <|return|>, etc. —
// so they don't render as raw garbage or pollute history. Boundary-safe: holds a
// trailing partial "<|…" until it completes. Channel content itself is kept as
// plain text (the reasoning stays visible, just without the markup).
export class HarmonyStripper {
  private buf = "";
  private static TOKEN = /<\|[^>]*\|>/g;

  push(chunk: string): string {
    this.buf += chunk;
    // Hold back a trailing, possibly-incomplete "<|…" token until it closes.
    let processUpTo = this.buf.length;
    const lt = this.buf.lastIndexOf("<");
    if (lt !== -1) {
      const rest = this.buf.slice(lt);
      if (rest.startsWith("<") && !rest.includes(">") && rest.length < 40) processUpTo = lt;
    }
    const head = this.buf.slice(0, processUpTo);
    this.buf = this.buf.slice(processUpTo);
    return head.replace(HarmonyStripper.TOKEN, "");
  }

  flush(): string {
    const o = this.buf.replace(HarmonyStripper.TOKEN, "");
    this.buf = "";
    return o;
  }
}

// Channel-aware filter for the "harmony" format some models (gemma3/4, gpt-oss)
// emit inline: <|start|>assistant<|channel|>analysis<|message|>…<|end|>,
// <|channel|>commentary to=functions.list_dir<|message|>{json}<|call|>,
// <|channel|>final<|message|>answer. We route:
//   analysis/thought/reasoning  -> reasoning, wrapped in <think>…</think> (dimmed)
//   commentary/tool/functions   -> dropped (those are tool-call narration; the
//                                   tool runs via the real interface, not as text)
//   final / anything else       -> the visible answer
// Boundary-safe across chunks; plain text with no <|…|> tokens passes through.
const HARMONY_THINK = new Set(["analysis", "thought", "thinking", "reasoning"]);
const HARMONY_DROP = new Set(["commentary", "tool", "tools", "functions"]);

export class HarmonyFilter {
  private buf = "";
  private state: "emit" | "name" = "emit";
  private channel = "final";
  private nameBuf = "";
  private inThink = false;

  push(chunk: string): string { this.buf += chunk; return this.drain(false); }
  flush(): string { let out = this.drain(true); if (this.inThink) { out += "</think>"; this.inThink = false; } return out; }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      const i = this.buf.indexOf("<|");
      if (i === -1) {
        // No token start. Hold a trailing lone "<" (could begin "<|") unless final.
        let end = this.buf.length;
        if (!final && this.buf.endsWith("<")) end -= 1;
        out += this.route(this.buf.slice(0, end));
        this.buf = this.buf.slice(end);
        return out;
      }
      const j = this.buf.indexOf("|>", i);
      if (j === -1) {
        // Incomplete token: emit text before it, hold the rest (drop it on flush).
        out += this.route(this.buf.slice(0, i));
        this.buf = final ? "" : this.buf.slice(i);
        return out;
      }
      out += this.route(this.buf.slice(0, i));
      const token = this.buf.slice(i, j + 2);
      this.buf = this.buf.slice(j + 2);
      out += this.handle(token);
    }
  }

  private handle(token: string): string {
    const name = token.slice(2, -2).trim().toLowerCase();
    if (name === "channel" || name === "start") { this.state = "name"; this.nameBuf = ""; return ""; }
    if (name === "message") {
      const ch = this.nameBuf.trim().split(/\s+/)[0]?.toLowerCase();
      if (ch) this.channel = ch;
      this.state = "emit";
      return "";
    }
    if (name === "end" || name === "call" || name === "return") {
      this.channel = "final"; this.state = "emit";
      if (this.inThink) { this.inThink = false; return "</think>"; }
      return "";
    }
    return ""; // <|constrain|> and any other control token: ignore
  }

  private route(text: string): string {
    if (!text) return "";
    if (this.state === "name") { this.nameBuf += text; return ""; }
    if (HARMONY_DROP.has(this.channel)) return "";
    if (HARMONY_THINK.has(this.channel)) {
      if (!this.inThink) { this.inThink = true; return "<think>" + text; }
      return text;
    }
    if (this.inThink) { this.inThink = false; return "</think>" + text; }
    return text;
  }
}

// Backwards-compatible reasoning splitter built on TagSplitter.
export interface Segment {
  text: string;
  think: boolean;
}

export class ThinkSplitter {
  private inner = new TagSplitter("<think>", "</think>");
  push(chunk: string): Segment[] {
    return this.inner.push(chunk).map(s => ({ text: s.text, think: s.inside }));
  }
  flush(): Segment[] {
    return this.inner.flush().map(s => ({ text: s.text, think: s.inside }));
  }
}
