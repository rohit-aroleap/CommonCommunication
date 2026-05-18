// v1.183: WhatsApp-style text formatting renderer.
//
// Parses WhatsApp's lite-markdown subset and renders it as nested
// React Native <Text> nodes. The wire format is unchanged — we still
// send `*bold*` to Periskope, WhatsApp's renderer formats it for the
// customer. This module only changes how OUR app displays messages so
// trainers see what the customer sees instead of literal asterisks.
//
// Supported markers:
//   *bold*        → bold
//   _italic_      → italic
//   ~strike~      → strikethrough
//   `mono`        → inline monospace
//   ```block```   → multi-line monospace
//   > quote       → blockquote (line-start)
//   - item        → bulleted list (line-start, also "* item")
//   1. item       → numbered list (line-start)
//
// Inline marker boundary rule (mirrors WhatsApp): opening marker must
// be flanked by a non-word char on its outside, closing marker must be
// flanked by a non-word char on its outside, and the content between
// must be non-empty and not start/end with whitespace. So `2*3=6` stays
// literal but `2 *3* 6` formats.
//
// Nesting works: `*hello _world_*` → bold "hello *italic* world".
// URLs are auto-detected and rendered as links (open in the browser).

import React from "react";
import { Linking, StyleSheet, Text, View, type TextStyle } from "react-native";
import { useStyles, useTheme, type Colors } from "@/theme";

// ───────────────────────── AST types ─────────────────────────

export type Block =
  | { kind: "para"; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "ul"; items: Span[][] }
  | { kind: "ol"; items: Span[][]; start: number }
  | { kind: "code"; text: string };

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; spans: Span[] }
  | { kind: "italic"; spans: Span[] }
  | { kind: "strike"; spans: Span[] }
  | { kind: "mono"; text: string }
  | { kind: "link"; url: string };

// ───────────────────────── Parser ─────────────────────────

export function parseWhatsApp(input: string): Block[] {
  if (!input) return [];
  // First pass: extract triple-backtick code blocks (anything inside is
  // literal, no further parsing). The outer text gets line-block parsed.
  const blocks: Block[] = [];
  const codeRe = /```([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(input)) !== null) {
    if (m.index > last) {
      blocks.push(...parseLineBlocks(input.slice(last, m.index)));
    }
    blocks.push({ kind: "code", text: m[1] });
    last = codeRe.lastIndex;
  }
  if (last < input.length) {
    blocks.push(...parseLineBlocks(input.slice(last)));
  }
  return blocks;
}

function parseLineBlocks(text: string): Block[] {
  if (!text) return [];
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // blockquote — consecutive "> " lines collapse into one
    if (/^>\s?/.test(line) && line.replace(/^>\s?/, "").length > 0) {
      const collected: string[] = [];
      while (
        i < lines.length &&
        /^>\s?/.test(lines[i]) &&
        lines[i].replace(/^>\s?/, "").length > 0
      ) {
        collected.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", spans: parseInline(collected.join("\n")) });
      continue;
    }

    // unordered list — "- foo" or "* foo" at line start
    if (/^[-*]\s+\S/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^[-*]\s+\S/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*]\s+/, "")));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // ordered list — "N. foo" at line start
    if (/^\d+\.\s+\S/.test(line)) {
      const items: Span[][] = [];
      const startMatch = line.match(/^(\d+)\.\s+/);
      const start = startMatch ? parseInt(startMatch[1], 10) : 1;
      while (i < lines.length && /^\d+\.\s+\S/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\.\s+/, "")));
        i++;
      }
      out.push({ kind: "ol", items, start });
      continue;
    }

    // paragraph — gather consecutive non-block-marker lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !(/^>\s?/.test(lines[i]) && lines[i].replace(/^>\s?/, "").length > 0) &&
      !/^[-*]\s+\S/.test(lines[i]) &&
      !/^\d+\.\s+\S/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push({ kind: "para", spans: parseInline(paraLines.join("\n")) });
  }
  return out;
}

// Word-char test for the boundary rule. Treat Unicode letters/digits as
// "word" — markers next to those don't trigger formatting.
const wordChar = /[\p{L}\p{N}]/u;
const isWordChar = (c: string | undefined): boolean => !!c && wordChar.test(c);

function parseInline(text: string): Span[] {
  const out: Span[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const c = text[i];

    // URL auto-detection. Run before inline markers so e.g. `_` inside
    // URLs isn't interpreted as italic.
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(text.slice(i))) {
      // Greedy but stop at whitespace/closing punct that's clearly trailing
      const um = text.slice(i).match(/^https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]'"]/i);
      if (um) {
        flush();
        out.push({ kind: "link", url: um[0] });
        i += um[0].length;
        continue;
      }
    }

    // Inline marker open?
    if (c === "*" || c === "_" || c === "~" || c === "`") {
      const before = i > 0 ? text[i - 1] : undefined;
      if (!isWordChar(before)) {
        const close = findCloser(text, i + 1, c);
        if (close > i + 1) {
          const inner = text.slice(i + 1, close);
          // Inline markers don't span newlines (matches WhatsApp behaviour).
          if (!inner.includes("\n")) {
            flush();
            if (c === "`") {
              out.push({ kind: "mono", text: inner });
            } else {
              const kind = c === "*" ? "bold" : c === "_" ? "italic" : "strike";
              const child = parseInline(inner);
              out.push({ kind, spans: child } as Span);
            }
            i = close + 1;
            continue;
          }
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// Find the index of the matching close marker, or -1 if none. The close
// marker is valid when:
//   - char immediately before it is not whitespace
//   - char immediately after it is not a word char
//   - content (between open and close) is non-empty
function findCloser(text: string, from: number, marker: string): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] !== marker) continue;
    const prev = text[j - 1];
    const next = j + 1 < text.length ? text[j + 1] : undefined;
    if (prev === undefined || prev === " " || prev === "\t" || prev === "\n") continue;
    if (isWordChar(next)) continue;
    return j;
  }
  return -1;
}

// ───────────────────────── Renderer ─────────────────────────

interface Props {
  text: string;
  // The base style of the surrounding bubble text. We apply this as the
  // outermost <Text>'s style so default font/color is inherited; nested
  // <Text>s only override what they need to (fontWeight, fontStyle, etc.).
  baseStyle?: TextStyle | TextStyle[];
}

export function FormattedText({ text, baseStyle }: Props) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const blocks = parseWhatsApp(text);

  // Fast path: single paragraph → emit a single <Text> tree, no <View>
  // wrapper. Most messages are short and this matches the old plain-text
  // rendering layout exactly so existing bubble metrics aren't disturbed.
  if (blocks.length === 1 && blocks[0].kind === "para") {
    return (
      <Text style={baseStyle}>
        {renderSpans(blocks[0].spans, colors)}
      </Text>
    );
  }

  // Multi-block: wrap in a View so block-level elements (quote bar,
  // bullets, code block) can have their own layout.
  return (
    <View style={styles.blocks}>
      {blocks.map((b, idx) => renderBlock(b, idx, styles, colors, baseStyle))}
    </View>
  );
}

function renderBlock(
  b: Block,
  idx: number,
  styles: ReturnType<typeof makeStyles>,
  colors: Colors,
  baseStyle?: TextStyle | TextStyle[],
): React.ReactNode {
  switch (b.kind) {
    case "para":
      return (
        <Text key={idx} style={baseStyle}>
          {renderSpans(b.spans, colors)}
        </Text>
      );
    case "quote":
      return (
        <View key={idx} style={styles.quote}>
          <Text style={[baseStyle, styles.quoteTxt]}>
            {renderSpans(b.spans, colors)}
          </Text>
        </View>
      );
    case "ul":
      return (
        <View key={idx} style={styles.list}>
          {b.items.map((spans, k) => (
            <View key={k} style={styles.listItem}>
              <Text style={[baseStyle, styles.bullet]}>•  </Text>
              <Text style={[baseStyle, styles.listItemTxt]}>
                {renderSpans(spans, colors)}
              </Text>
            </View>
          ))}
        </View>
      );
    case "ol":
      return (
        <View key={idx} style={styles.list}>
          {b.items.map((spans, k) => (
            <View key={k} style={styles.listItem}>
              <Text style={[baseStyle, styles.bullet]}>{b.start + k}.  </Text>
              <Text style={[baseStyle, styles.listItemTxt]}>
                {renderSpans(spans, colors)}
              </Text>
            </View>
          ))}
        </View>
      );
    case "code":
      return (
        <View key={idx} style={styles.codeBlock}>
          <Text style={[baseStyle, styles.codeBlockTxt]}>{b.text}</Text>
        </View>
      );
  }
}

function renderSpans(spans: Span[], colors: Colors): React.ReactNode {
  return spans.map((s, idx) => renderSpan(s, idx, colors));
}

function renderSpan(s: Span, idx: number, colors: Colors): React.ReactNode {
  switch (s.kind) {
    case "text":
      return <Text key={idx}>{s.text}</Text>;
    case "bold":
      return (
        <Text key={idx} style={{ fontWeight: "700" }}>
          {renderSpans(s.spans, colors)}
        </Text>
      );
    case "italic":
      return (
        <Text key={idx} style={{ fontStyle: "italic" }}>
          {renderSpans(s.spans, colors)}
        </Text>
      );
    case "strike":
      return (
        <Text key={idx} style={{ textDecorationLine: "line-through" }}>
          {renderSpans(s.spans, colors)}
        </Text>
      );
    case "mono":
      return (
        <Text
          key={idx}
          style={{
            fontFamily: "Courier",
            fontSize: 13,
            backgroundColor: "rgba(127,127,127,0.18)",
          }}
        >
          {s.text}
        </Text>
      );
    case "link":
      return (
        <Text
          key={idx}
          style={{ color: colors.green, textDecorationLine: "underline" }}
          onPress={() => Linking.openURL(s.url).catch(() => {})}
        >
          {s.url}
        </Text>
      );
  }
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    blocks: { gap: 4 },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.green,
      paddingLeft: 8,
      marginVertical: 2,
      opacity: 0.92,
    },
    quoteTxt: { fontStyle: "italic" },
    list: { marginVertical: 2, gap: 2 },
    listItem: { flexDirection: "row", alignItems: "flex-start" },
    bullet: { fontWeight: "500", minWidth: 18 },
    listItemTxt: { flex: 1 },
    codeBlock: {
      backgroundColor: "rgba(127,127,127,0.18)",
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 6,
      marginVertical: 2,
    },
    codeBlockTxt: { fontFamily: "Courier", fontSize: 13 },
  });
}
