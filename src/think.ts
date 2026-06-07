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

// Detects when a model is stuck repeating itself (a degenerate generation loop —
// e.g. gemma repeating the same paragraph for thousands of tokens). Fed the
// streamed text; trips once any substantial line has recurred `threshold` times.
export class RepetitionGuard {
  private buf = "";
  private counts = new Map<string, number>();
  private _tripped = false;
  constructor(private threshold = 6, private minLen = 24) {}

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
    // Some models stream without newlines — flush a long line-less buffer too.
    if (this.buf.length > 4000) { this.record(this.buf); this.buf = ""; }
    return this._tripped;
  }

  private record(line: string): void {
    const norm = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (norm.length < this.minLen) return;
    const c = (this.counts.get(norm) ?? 0) + 1;
    this.counts.set(norm, c);
    if (c >= this.threshold) this._tripped = true;
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
