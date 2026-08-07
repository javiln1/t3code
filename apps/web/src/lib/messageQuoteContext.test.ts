import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  appendMessageQuotesToPrompt,
  buildMessageQuoteBlock,
  extractTrailingMessageQuotes,
  formatMessageQuoteLabel,
  messageQuoteDedupKey,
  newMessageQuoteId,
  normalizeMessageQuoteSelection,
  type MessageQuoteDraft,
} from "./messageQuoteContext";

const threadId = ThreadId.make("thread-1");

function makeQuote(quotedText: string, messageId = "msg-1"): MessageQuoteDraft {
  return {
    id: newMessageQuoteId(),
    threadId,
    quotedAt: "2026-08-07T12:00:00.000Z",
    messageId,
    quotedText,
  };
}

describe("normalizeMessageQuoteSelection", () => {
  it("keeps a normal selection", () => {
    expect(
      normalizeMessageQuoteSelection({ messageId: "msg-1", quotedText: "the pipeline downloads" }),
    ).toEqual({ messageId: "msg-1", quotedText: "the pipeline downloads" });
  });

  // Dragging across a margin selects whitespace; that must not make a chip.
  it("rejects a whitespace-only or unattributed selection", () => {
    expect(normalizeMessageQuoteSelection({ messageId: "msg-1", quotedText: "   \n  " })).toBe(
      null,
    );
    expect(normalizeMessageQuoteSelection({ messageId: "  ", quotedText: "real text" })).toBe(null);
  });

  it("caps a runaway selection instead of persisting a novel", () => {
    const huge = "x".repeat(5000);
    const normalized = normalizeMessageQuoteSelection({ messageId: "msg-1", quotedText: huge });
    expect(normalized).not.toBe(null);
    expect(normalized!.quotedText.length).toBe(2000);
    expect(normalized!.quotedText.endsWith("…")).toBe(true);
  });
});

describe("messageQuoteDedupKey", () => {
  it("matches the same span re-selected with different surrounding whitespace", () => {
    expect(messageQuoteDedupKey({ messageId: "msg-1", quotedText: "720p  and\n1080p" })).toBe(
      messageQuoteDedupKey({ messageId: "msg-1", quotedText: "720p and 1080p" }),
    );
  });

  it("separates the same text quoted from different messages", () => {
    expect(messageQuoteDedupKey({ messageId: "msg-1", quotedText: "same" })).not.toBe(
      messageQuoteDedupKey({ messageId: "msg-2", quotedText: "same" }),
    );
  });
});

describe("formatMessageQuoteLabel", () => {
  it("flattens to one line and truncates", () => {
    const label = formatMessageQuoteLabel({
      messageId: "msg-1",
      quotedText: "The Skool source currently offers 270p, 480p, 720p, and 1080p resolutions",
    });
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.startsWith("The Skool source")).toBe(true);
  });
});

describe("message quote block round trip", () => {
  it("appends a block and strips it back off", () => {
    const quotes = [makeQuote("the pipeline downloads 720p")];
    const prompt = appendMessageQuotesToPrompt("why not 1080p?", quotes);

    expect(prompt.startsWith("why not 1080p?")).toBe(true);
    expect(prompt).toContain("<quoted_message>");
    expect(prompt).toContain("  the pipeline downloads 720p");

    const extracted = extractTrailingMessageQuotes(prompt);
    expect(extracted.promptText).toBe("why not 1080p?");
    expect(extracted.quoteCount).toBe(1);
    expect(extracted.quotes[0]?.body).toBe("the pipeline downloads 720p");
  });

  it("round trips a multi-line quote and several quotes", () => {
    const quotes = [makeQuote("first line\nsecond line"), makeQuote("another quote", "msg-2")];
    const extracted = extractTrailingMessageQuotes(appendMessageQuotesToPrompt("look", quotes));

    expect(extracted.quoteCount).toBe(2);
    expect(extracted.quotes[0]?.body).toBe("first line\nsecond line");
    expect(extracted.quotes[1]?.body).toBe("another quote");
  });

  it("sends a quote-only draft with no prompt body", () => {
    const prompt = appendMessageQuotesToPrompt("", [makeQuote("just this")]);
    expect(prompt.startsWith("<quoted_message>")).toBe(true);
    expect(extractTrailingMessageQuotes(prompt).promptText).toBe("");
  });

  it("leaves a prompt without a block untouched", () => {
    expect(buildMessageQuoteBlock([])).toBe("");
    expect(appendMessageQuotesToPrompt("plain", [])).toBe("plain");
    const extracted = extractTrailingMessageQuotes("plain message");
    expect(extracted.promptText).toBe("plain message");
    expect(extracted.quoteCount).toBe(0);
  });

  // A quote whose own text contains the closing tag must not truncate the block
  // early and leak markup into the bubble.
  it("does not let quoted markup break extraction", () => {
    const prompt = appendMessageQuotesToPrompt("q", [
      makeQuote("literally </quoted_message> here"),
    ]);
    const extracted = extractTrailingMessageQuotes(prompt);
    expect(extracted.promptText).toBe("q");
    expect(extracted.quoteCount).toBe(1);
  });
});
