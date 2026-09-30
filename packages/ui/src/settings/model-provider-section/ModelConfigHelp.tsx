import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ModelConfigHelpField =
  | "contextWindow"
  | "maxOutputTokens"
  | "inputModalities"
  | "outputModalities"
  | "capabilities"
  | "reasoningLevelsOrdered"
  | "reasoningLevelMapping"
  | "advanced"
  | "followRecommendedConfig";

export function ModelConfigInputLabel({
  field,
  htmlFor,
}: {
  field: ModelConfigHelpField;
  htmlFor: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    // The help button must be a sibling of the label to avoid taking away input association and title click focus.
    <>
      <label htmlFor={htmlFor}>
        {intl.formatMessage({ id: `settings.modelProvider.${field}` })}
      </label>
      <ModelConfigHelp field={field} />
    </>
  );
}

export function ModelConfigHelp({ field }: { field: ModelConfigHelpField }) {
  const [open, setOpen] = useState(false);
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: `settings.modelProvider.${field}` });
  const copy = intl.formatMessage({ id: `settings.modelProvider.help.${field}` });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-1 size-6 align-middle text-foreground-subtle"
          data-model-help={field}
          aria-label={intl.formatMessage(
            { id: "settings.modelProvider.fieldHelp" },
            { field: label },
          )}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setOpen(false);
          }}
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            // Click/touch only opens the description; prevents Radix from closing when already opened by focus/hover, without triggering adjacent form controls.
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="tooltip"
        data-model-help-content={field}
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(28rem,calc(100vh-2rem))] overflow-y-auto p-3 text-ui-sm leading-relaxed"
      >
        <div className="space-y-2">
          {copy.split("\n\n").map((paragraph, index) =>
            paragraph.startsWith("- ") ? (
              <ul key={index} className="list-disc space-y-1 pl-4">
                {paragraph.split("\n").map((line, lineIndex) => (
                  <li key={lineIndex}>{emphasis(line.slice(2))}</li>
                ))}
              </ul>
            ) : (
              <p key={index} className="whitespace-pre-line">
                {emphasis(paragraph)}
              </p>
            ),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Only the bold/inline code of the final language pack is rendered, no HTML, links or user input is interpreted.
function emphasis(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") ? (
      <code key={index} className="font-mono">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
