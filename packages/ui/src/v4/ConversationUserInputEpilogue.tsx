import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The engine-appended text inside a user message.
 *
 * Every ask a dwf subagent receives = the instruction body written by the script + an epilogue
 * appended by the driver (the result criteria, the JSON Schema for `submit_result`); on a nudge
 * turn the whole thing is engine text. What a reader opening a subagent transcript wants to see is
 * "what the script told it to do", and the epilogue is a verbatim repetition of technical
 * boilerplate — so it is folded into a disclosure that is collapsed by default, but **not erased**:
 * while debugging you need to be able to check exactly what the subagent was told. The engine marks
 * the boundary with `epilogueStart` on the line; this module only splits and folds.
 */

/**
 * Splits a line into body and epilogue. Out of bounds or absent → no epilogue: showing a little
 * extra is better than eating into the body.
 */
export function splitUserInputEpilogue(
  text: string,
  epilogueStart: number | undefined,
): { body: string; epilogue?: string } {
  if (epilogueStart === undefined || epilogueStart < 0 || epilogueStart > text.length) {
    return { body: text };
  }
  return { body: text.slice(0, epilogueStart), epilogue: text.slice(epilogueStart) };
}

/**
 * Drops the leading blank line and the `---` separator of the epilogue: in the source that dash is
 * the marker for "the body ends here", and the disclosure itself already expresses that boundary,
 * so drawing another one is noise. The second `---` between paragraphs (between the quality
 * epilogue and the schema epilogue) is kept.
 */
function trimEpilogueLead(text: string): string {
  return text.replace(/^\s*(?:---[ \t]*\n)?/u, "").trimEnd();
}

export function ConversationUserInputEpilogue({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.userInput.epilogue.label" });
  return (
    <div data-v4-user-input-epilogue="true" className="flex min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-md text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        {label}
      </button>
      {open ? (
        // There is an indented JSON Schema in the endnote, arranged in a fixed-width pre-formatted format; secondary color - it is reference material, not the message body.
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle"
          data-v4-user-input-epilogue-body="true"
        >
          {trimEpilogueLead(text)}
        </pre>
      ) : null}
    </div>
  );
}
