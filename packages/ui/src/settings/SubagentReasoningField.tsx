import { useEffect, useRef, useState } from "react";
import { CircleHelp, Loader2 } from "lucide-react";
import { ZCODE_AGENT_PROVIDER, type ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type SubagentReasoningFieldState =
  | { kind: "not-applicable" }
  | { kind: "unknown"; status: "loading" | "unavailable" }
  | { kind: "unsupported" }
  | { kind: "supported"; option: ZCodeConfigOption };

export function SubagentReasoningField({
  disabled,
  intl,
  labelVisibilityClassName,
  onValueCommit,
  state,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  labelVisibilityClassName: string;
  onValueCommit: (value: string) => void;
  state: SubagentReasoningFieldState;
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const interactive = state.kind === "supported" && !disabled;

  useEffect(() => {
    if (!interactive) {
      // Radix Root's disabled only disables the trigger and does not close the portal.
      // menu. When a field loses catalog write permission, the interactive state must be recovered synchronously.
      setOpen(false);
    }
  }, [interactive]);

  if (state.kind === "not-applicable" || state.kind === "unsupported") {
    return null;
  }

  if (state.kind === "unknown") {
    const loading = state.status === "loading";
    const placeholderLabel = intl.formatMessage({
      id: loading ? "common.loading" : "settings.subagents.reasoningUnavailable",
    });
    return (
      <span
        aria-disabled="true"
        aria-label={placeholderLabel}
        data-subagent-thought-level-loading={loading ? "true" : undefined}
        data-subagent-thought-level-unavailable={loading ? undefined : "true"}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-input-border bg-input px-2 py-1.5 text-ui-base text-foreground-subtle"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <CircleHelp className="size-4" aria-hidden="true" />
        )}
        <span className={labelVisibilityClassName}>{placeholderLabel}</span>
      </span>
    );
  }

  return (
    <ThoughtLevelCycleControl
      intl={intl}
      option={state.option}
      provider={ZCODE_AGENT_PROVIDER}
      onCurrentValueCommit={onValueCommit}
      showInvalidCurrentValue
      disabled={!interactive}
      open={interactive ? open : false}
      onOpenChange={(nextOpen) => {
        if (nextOpen && !interactive) {
          return;
        }
        setOpen(nextOpen);
      }}
      triggerRef={triggerRef}
      restoreFocusSelector={null}
      labelVisibilityClassName={labelVisibilityClassName}
      triggerClassName="h-8 rounded-lg border border-input-border bg-input px-2 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input"
      onValueChange={onValueCommit}
    />
  );
}
