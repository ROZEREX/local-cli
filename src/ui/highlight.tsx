import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme";

// Lightweight, dependency-free syntax highlighter that emits colored Ink spans.
// Not a full parser — a pragmatic tokenizer that makes common code (JS/TS, HTML
// with embedded script/style, CSS, JSON, Python, bash) look great in the TUI.

export interface Span { text: string; color?: string; italic?: boolean; }
type TType =
  | "keyword" | "func" | "type" | "string" | "number" | "comment"
  | "constant" | "operator" | "property" | "tag" | "attr" | "plain";

const S = theme.syntax;
const COLOR: Record<TType, string> = {
  keyword: S.keyword, func: S.func, type: S.type, string: S.string, number: S.number,
  comment: S.comment, constant: S.constant, operator: S.operator, property: S.property,
  tag: S.tag, attr: S.attr, plain: S.plain,
};

const JS_KW = new Set("const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this super yield delete void interface type enum public private protected readonly static get set as namespace implements declare abstract is keyof infer satisfies".split(" "));
const PY_KW = new Set("def class return if elif else for while import from as try except finally with lambda yield async await pass break continue raise global nonlocal and or not is in self None True False assert del print".split(" "));
const BASH_KW = new Set("if then fi else elif for in do done while case esac function return export local readonly echo cd ls cat rm cp mv mkdir set unset source".split(" "));
const CONSTS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "NaN", "Infinity"]);

interface Tok { text: string; type: TType; }

function scanGeneric(src: string, keywords: Set<string>, hashComment = false): Tok[] {
  const toks: Tok[] = [];
  const push = (text: string, type: TType) => { if (text) toks.push({ text, type }); };
  let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? "";
    if (c === "/" && c2 === "/") { let j = i + 2; while (j < n && src[j] !== "\n") j++; push(src.slice(i, j), "comment"); i = j; continue; }
    if (hashComment && c === "#") { let j = i + 1; while (j < n && src[j] !== "\n") j++; push(src.slice(i, j), "comment"); i = j; continue; }
    if (c === "/" && c2 === "*") { let j = i + 2; while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++; j = Math.min(n, j + 2); push(src.slice(i, j), "comment"); i = j; continue; }
    if (c === '"' || c === "'" || c === "`") { const q = c; let j = i + 1; while (j < n) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === q) { j++; break; } j++; } push(src.slice(i, j), "string"); i = j; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(c2))) { let j = i + 1; while (j < n && /[0-9a-fA-FxXeE._]/.test(src[j]!)) j++; push(src.slice(i, j), "number"); i = j; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      let k = j; while (k < n && src[k] === " ") k++;
      let type: TType = "plain";
      if (keywords.has(word)) type = "keyword";
      else if (CONSTS.has(word)) type = "constant";
      else if (src[k] === "(") type = "func";
      else if (/^[A-Z]/.test(word)) type = "type";
      push(word, type); i = j; continue;
    }
    if ("{}()[].,;:+-*/%=<>!&|^~?".includes(c)) { push(c, "operator"); i++; continue; }
    push(c, "plain"); i++;
  }
  return toks;
}

function scanCss(src: string): Tok[] {
  const toks: Tok[] = [];
  const push = (text: string, type: TType) => { if (text) toks.push({ text, type }); };
  let i = 0; const n = src.length; let inBlock = false;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "*") { let j = i + 2; while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++; j = Math.min(n, j + 2); push(src.slice(i, j), "comment"); i = j; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < n && src[j] !== q) j++; j = Math.min(n, j + 1); push(src.slice(i, j), "string"); i = j; continue; }
    if (c === "#" || c === ".") { let j = i + 1; while (j < n && /[A-Za-z0-9_-]/.test(src[j]!)) j++; push(src.slice(i, j), inBlock ? "number" : "type"); i = j; continue; }
    if (c === "@") { let j = i + 1; while (j < n && /[A-Za-z-]/.test(src[j]!)) j++; push(src.slice(i, j), "keyword"); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[0-9.a-z%]/.test(src[j]!)) j++; push(src.slice(i, j), "number"); i = j; continue; }
    if (c === "{") { inBlock = true; push(c, "operator"); i++; continue; }
    if (c === "}") { inBlock = false; push(c, "operator"); i++; continue; }
    if (/[A-Za-z_-]/.test(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_-]/.test(src[j]!)) j++;
      const word = src.slice(i, j); let k = j; while (k < n && src[k] === " ") k++;
      push(word, inBlock && src[k] === ":" ? "property" : "plain"); i = j; continue;
    }
    if (":;,()".includes(c)) { push(c, "operator"); i++; continue; }
    push(c, "plain"); i++;
  }
  return toks;
}

function scanHtml(src: string): Tok[] {
  const toks: Tok[] = [];
  const push = (text: string, type: TType) => { if (text) toks.push({ text, type }); };
  let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "<" && src.startsWith("<!--", i)) { const end = src.indexOf("-->", i); const j = end === -1 ? n : end + 3; push(src.slice(i, j), "comment"); i = j; continue; }
    if (c === "<") {
      // embedded script/style → highlight inner with the right scanner
      const tagMatch = /^<\s*(script|style)\b/i.exec(src.slice(i));
      push("<", "operator"); i++;
      if (src[i] === "/") { push("/", "operator"); i++; }
      let j = i; while (j < n && /[A-Za-z0-9-]/.test(src[j]!)) j++;
      push(src.slice(i, j), "tag"); i = j;
      // attributes until >
      while (i < n && src[i] !== ">") {
        const ch = src[i]!;
        if (ch === '"' || ch === "'") { const q = ch; let k = i + 1; while (k < n && src[k] !== q) k++; k = Math.min(n, k + 1); push(src.slice(i, k), "string"); i = k; continue; }
        if (/[A-Za-z_-]/.test(ch)) { let k = i + 1; while (k < n && /[A-Za-z0-9_:-]/.test(src[k]!)) k++; push(src.slice(i, k), "attr"); i = k; continue; }
        if (ch === "/" || ch === "=") { push(ch, "operator"); i++; continue; }
        push(ch, "plain"); i++;
      }
      if (src[i] === ">") { push(">", "operator"); i++; }
      // dive into script/style body
      if (tagMatch) {
        const kind = tagMatch[1]!.toLowerCase();
        const close = new RegExp(`</\\s*${kind}`, "i");
        const rest = src.slice(i); const m = close.exec(rest);
        const bodyEnd = m ? i + m.index : n;
        const body = src.slice(i, bodyEnd);
        for (const t of (kind === "style" ? scanCss(body) : scanGeneric(body, JS_KW))) toks.push(t);
        i = bodyEnd;
      }
      continue;
    }
    let j = i; while (j < n && src[j] !== "<") j++;
    push(src.slice(i, j), "plain"); i = j;
  }
  return toks;
}

function tokenize(code: string, lang: string): Tok[] {
  const l = lang.toLowerCase();
  if (["html", "htm", "xml", "svg", "vue"].includes(l)) return scanHtml(code);
  if (["css", "scss", "less"].includes(l)) return scanCss(code);
  if (["py", "python"].includes(l)) return scanGeneric(code, PY_KW, true);
  if (["sh", "bash", "shell", "zsh"].includes(l)) return scanGeneric(code, BASH_KW, true);
  // js/ts/json/and unknown → C-like
  return scanGeneric(code, JS_KW);
}

// Tokens → array of lines, each a list of spans.
export function highlightToLines(code: string, lang: string): Span[][] {
  const toks = tokenize(code, lang);
  const lines: Span[][] = [[]];
  for (const tok of toks) {
    const color = COLOR[tok.type];
    const parts = tok.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, color, italic: tok.type === "comment" });
    });
  }
  return lines;
}

// ─── Code block component (framed + line numbers) ─────────────────────────────
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const lines = highlightToLines(code.replace(/\n$/, ""), lang);
  const gutterW = String(lines.length).length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.color.dim} marginY={0}>
      {lang ? (
        <Box paddingX={1}>
          <Text color={theme.color.accent}>{theme.icon.spark} </Text>
          <Text color={theme.color.dim}>{lang}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" paddingX={1}>
        {lines.map((spans, i) => (
          <Text key={i}>
            <Text color={theme.color.dim}>{String(i + 1).padStart(gutterW, " ")} </Text>
            {spans.length === 0 ? <Text> </Text> : spans.map((s, j) => (
              <Text key={j} color={s.color} italic={s.italic}>{s.text}</Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
