import { QuoteIcon, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatMessageQuoteLabel, type MessageQuoteDraft } from "~/lib/messageQuoteContext";
import { cn } from "~/lib/utils";

interface ComposerPendingMessageQuotesProps {
  quotes: ReadonlyArray<MessageQuoteDraft>;
  onRemove: (quoteId: string) => void;
  className?: string;
}

/**
 * Chips for assistant text the user highlighted and added to the composer. The
 * chip shows the opening words; the tooltip carries the full quote, since a
 * long selection is truncated to keep the chip row from swallowing the
 * composer.
 */
export function ComposerPendingMessageQuotes({
  quotes,
  onRemove,
  className,
}: ComposerPendingMessageQuotesProps) {
  if (quotes.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {quotes.map((quote) => {
        const label = formatMessageQuoteLabel(quote);
        return (
          <Tooltip key={quote.id}>
            <TooltipTrigger
              render={
                <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
                  <QuoteIcon className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
                  <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
                  <button
                    type="button"
                    aria-label={`Remove quote ${label}`}
                    className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onRemove(quote.id);
                    }}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              }
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
              {quote.quotedText}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
