import { QuoteIcon, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
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
                <ContextChip className="pr-1 select-none">
                  <QuoteIcon />
                  <ContextChipLabel>{label}</ContextChipLabel>
                  <ContextChipAction
                    type="button"
                    aria-label={`Remove quote ${label}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onRemove(quote.id);
                    }}
                  >
                    <X className="size-3" aria-hidden />
                  </ContextChipAction>
                </ContextChip>
              }
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {quote.quotedText}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
