import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";
import { CodeBlock } from "./highlight";

// Terminal markdown renderer: fenced code blocks get real syntax highlighting,
// plus styled headings, lists, blockquotes, and inline bold/italic/code.

interface Props { text: string; }

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "text"; lines: string[] };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fence = (lines[i] ?? "").match(/^\s*```(\w*)/);
    if (fence) {
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) { code.push(lines[i] ?? ""); i++; }
      i++; // closing fence
      blocks.push({ type: "code", lang, code: code.join("\n") });
    } else {
      const text: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) { text.push(lines[i] ?? ""); i++; }
      blocks.push({ type: "text", lines: text });
    }
  }
  return blocks;
}

// Inline: **bold**, *italic*, `code`.
function Inline({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactElement[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, key = 0, m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(<Text key={key++}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<Text key={key++} bold color={theme.color.fg}>{tok.slice(2, -2)}</Text>);
    else if (tok.startsWith("`")) parts.push(<Text key={key++} color={theme.color.accent}>{tok.slice(1, -1)}</Text>);
    else parts.push(<Text key={key++} italic>{tok.slice(1, -1)}</Text>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<Text key={key++}>{text.slice(last)}</Text>);
  return <Text color={theme.color.fg}>{parts}</Text>;
}

function TextLine({ line }: { line: string }): React.ReactElement {
  const heading = line.match(/^(#{1,6})\s+(.*)/);
  if (heading) {
    return <Text bold color={theme.color.primary}>{theme.icon.arrowR} {heading[2]}</Text>;
  }
  const bullet = line.match(/^(\s*)[-*]\s+(.*)/);
  if (bullet) {
    return <Text>{bullet[1]}<Text color={theme.color.accent}>{theme.icon.bullet} </Text><Inline text={bullet[2] ?? ""} /></Text>;
  }
  const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)/);
  if (numbered) {
    return <Text>{numbered[1]}<Text color={theme.color.accent} bold>{numbered[2]}. </Text><Inline text={numbered[3] ?? ""} /></Text>;
  }
  const quote = line.match(/^>\s?(.*)/);
  if (quote) {
    return <Text color={theme.color.dim}><Text color={theme.color.accent}>{theme.icon.quote}</Text> <Inline text={quote[1] ?? ""} /></Text>;
  }
  if (!line.trim()) return <Text> </Text>;
  return <Inline text={line} />;
}

export function Markdown({ text }: Props): React.ReactElement {
  const blocks = splitBlocks(text.trimEnd());
  return (
    <Box flexDirection="column">
      {blocks.map((block, bi) =>
        block.type === "code" ? (
          <CodeBlock key={bi} code={block.code} lang={block.lang} />
        ) : (
          <Box key={bi} flexDirection="column">
            {block.lines.map((l, li) => <TextLine key={li} line={l} />)}
          </Box>
        )
      )}
    </Box>
  );
}
