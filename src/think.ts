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
