import { type ThreadId } from "@t3tools/contracts";

const MESSAGE_QUOTE_TEXT_LIMIT = 2000;
const MESSAGE_QUOTE_LABEL_LIMIT = 60;

const TRAILING_MESSAGE_QUOTE_BLOCK_PATTERN =
  /\n*<quoted_message>\n([\s\S]*?)\n<\/quoted_message>\s*$/;

/**
 * A span of assistant prose the user highlighted and pushed into the composer,
 * so a follow-up can point at an exact sentence instead of paraphrasing it.
 *
 * Kept JSON-serializable for the same reason as element contexts: it rides
 * through `localStorage` persistence and draft restoration untouched.
 */
export interface MessageQuoteSelection {
  /** Message the text was highlighted in — the provenance the agent needs. */
  messageId: string;
  /** Normalized, length-capped selection. */
  quotedText: string;
}

export interface MessageQuoteDraft extends MessageQuoteSelection {
  /** Stable composer-side id used for keyed rendering + dedupe. */
  id: string;
  threadId: ThreadId;
  /** ISO-8601 wall clock quote time. */
  quotedAt: string;
}

export interface ParsedMessageQuoteEntry {
  header: string;
  body: string;
}

export interface ExtractedMessageQuotes {
  promptText: string;
  quoteCount: number;
  quotes: ParsedMessageQuoteEntry[];
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Clamp a raw DOM selection before it lands in the draft. A selection can span
 * a whole reply, so the cap keeps a stray triple-click from persisting a novel.
 * Returns null for a whitespace-only selection — dragging across a margin
 * should not produce a chip.
 */
export function normalizeMessageQuoteSelection(raw: {
  messageId: string;
  quotedText: string;
}): MessageQuoteSelection | null {
  const messageId = raw.messageId.trim();
  const quotedText = truncateString(normalizeText(raw.quotedText), MESSAGE_QUOTE_TEXT_LIMIT);
  if (messageId.length === 0 || quotedText.trim().length === 0) {
    return null;
  }
  return { messageId, quotedText };
}

/**
 * Stable dedupe key. Re-selecting the same span in the same message adds one
 * chip, not one per drag. Whitespace is collapsed so a selection that grabs a
 * trailing newline still matches the one that didn't.
 */
export function messageQuoteDedupKey(quote: MessageQuoteSelection): string {
  return `${quote.messageId}|${quote.quotedText.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** Compact chip label — the opening words of the quote, on one line. */
export function formatMessageQuoteLabel(quote: MessageQuoteSelection): string {
  const singleLine = quote.quotedText.replace(/\s+/g, " ").trim();
  return truncateString(singleLine, MESSAGE_QUOTE_LABEL_LIMIT);
}

function indentLines(value: string): string[] {
  return value.split("\n").map((line) => `  ${line}`);
}

/**
 * Serialize quotes into the `<quoted_message>` block appended to the outgoing
 * message. Same `- header:` + two-space-body shape as `<element_context>` and
 * `<terminal_context>`, so the blocks compose cleanly when several are present.
 */
export function buildMessageQuoteBlock(quotes: ReadonlyArray<MessageQuoteSelection>): string {
  if (quotes.length === 0) return "";
  const lines: string[] = [];
  for (let index = 0; index < quotes.length; index += 1) {
    const quote = quotes[index]!;
    lines.push("- quoted from an earlier assistant message:");
    lines.push(...indentLines(quote.quotedText.trim()));
    if (index < quotes.length - 1) lines.push("");
  }
  return ["<quoted_message>", ...lines, "</quoted_message>"].join("\n");
}

export function appendMessageQuotesToPrompt(
  prompt: string,
  quotes: ReadonlyArray<MessageQuoteSelection>,
): string {
  const block = buildMessageQuoteBlock(quotes);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

const MESSAGE_QUOTE_ID_PREFIX = "mq_";
let nextMessageQuoteSequence = 0;

export function newMessageQuoteId(): string {
  nextMessageQuoteSequence += 1;
  return `${MESSAGE_QUOTE_ID_PREFIX}${nextMessageQuoteSequence.toString(36)}`;
}

/**
 * Mirror image of `appendMessageQuotesToPrompt` for transcript display: strips
 * the trailing block so the user's bubble renders their own words plus quote
 * cards, never the raw markup.
 */
export function extractTrailingMessageQuotes(prompt: string): ExtractedMessageQuotes {
  const match = TRAILING_MESSAGE_QUOTE_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, quoteCount: 0, quotes: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const quotes = parseMessageQuoteEntries(match[1] ?? "");
  return { promptText, quoteCount: quotes.length, quotes };
}

function parseMessageQuoteEntries(block: string): ParsedMessageQuoteEntry[] {
  const entries: ParsedMessageQuoteEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;
  const commit = () => {
    if (!current) return;
    entries.push({ header: current.header, body: current.bodyLines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      commit();
      current = { header: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("  ")) current.bodyLines.push(line.slice(2));
    else if (line.length === 0) current.bodyLines.push("");
  }
  commit();
  return entries;
}
