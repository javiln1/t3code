import {
  normalizeMessageQuoteSelection,
  type MessageQuoteSelection,
} from "~/lib/messageQuoteContext";

/** Drop the menu just below the selection so it never sits under the pointer. */
const SELECTION_MENU_OFFSET_Y = 8;

export interface MessageQuoteSelectionRead {
  selection: MessageQuoteSelection;
  /** Verbatim selection for the clipboard — normalization is for the quote only. */
  clipboardText: string;
  position: { x: number; y: number };
}

/**
 * Read the live DOM selection as a quotable span, or null when there's nothing
 * worth offering a menu for.
 *
 * Requires the range to both start and end inside `container`: a drag that
 * merely passes through this message on its way somewhere else is not a quote
 * of this message, and attributing it to one would put the wrong `messageId`
 * on the chip.
 */
export function readMessageQuoteSelection(
  container: HTMLElement | null,
  messageId: string,
): MessageQuoteSelectionRead | null {
  if (!container) return null;
  const domSelection = window.getSelection();
  if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
    return null;
  }
  const range = domSelection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const clipboardText = domSelection.toString();
  const selection = normalizeMessageQuoteSelection({ messageId, quotedText: clipboardText });
  if (!selection) return null;

  const rect = range.getBoundingClientRect();
  return {
    selection,
    clipboardText,
    position: {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.bottom + SELECTION_MENU_OFFSET_Y),
    },
  };
}

/** Drop the highlight once the user has acted on it. */
export function clearDomSelection(): void {
  window.getSelection()?.removeAllRanges();
}
