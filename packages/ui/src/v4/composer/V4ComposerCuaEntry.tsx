/**
 * The always-present entry button of the CUA input box.
 *
 * Purely presentational: every state decision lives in useCuaComposerEntry / cuaComposerEntryState;
 * this only handles "do not render when it is not visible" and maps the view into the DOM. It is
 * deliberately given the same visual weight as the toolbar's other controls, so that in unavailable
 * scenarios it does not mislead users into thinking that installing it is enough to use it.
 */
import { memo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { TID_V4_COMPOSER_CUA_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import {
  useCuaComposerEntry,
  type UseCuaComposerEntryParams,
} from "@/hooks/useCuaComposerEntry.js";

type V4ComposerCuaEntryProps = UseCuaComposerEntryParams;

/**
 * The platform gate front layer: when the platform does not support it (or the host simply provides
 * no platform / services context at all), the inner layer is not mounted either.
 *
 * There are two reasons for splitting this into two layers:
 * 1. Semantics — "if it is not visible it should incur no background cost at all". When the
 *    platform gate does not pass, no settings subscription is created, no plugin store is read, and
 *    no permission polling starts, which is more thorough than evaluating in the inner layer and
 *    then returning null.
 * 2. Robustness — the composer renders in hosts without a PlatformProvider / ServiceProvider
 *    (including the existing component-level tests). The usePlatform / useServices that the inner
 *    layer uses throw when a provider is missing, dragging the whole composer down with them. The
 *    optional variants are checked here instead, and a missing provider silently degrades to not
 *    rendering.
 */
function V4ComposerCuaEntryImpl(props: V4ComposerCuaEntryProps) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const platformSupported =
    platform !== null &&
    services !== null &&
    (supportsLocalMacCuaPermissionOnboarding(platform) || supportsLocalWindowsCuaEntry(platform));
  if (!platformSupported) return null;
  return <V4ComposerCuaEntryMounted {...props} />;
}

function V4ComposerCuaEntryMounted(props: V4ComposerCuaEntryProps) {
  const { intl } = useZCodeIntl();
  const { view, onActivate } = useCuaComposerEntry(props);
  const label = intl.formatMessage({ id: "chat.toolbar.computerUse.label" });

  // The remaining three layers of visibility gates (settings page hidden/mac service missing/computer control not enabled) → do not render DOM.
  if (!view.visible) return null;
  const tooltip = intl.formatMessage({ id: view.tooltipMessageId });

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_CUA_ENTRY}
        data-composer-collapse-priority="0"
        // e2e / Troubleshooting anchor: external UI status and disabling reasons to avoid testing to infer color class names.
        data-cua-state={view.uiState}
        data-cua-interaction-disabled={view.interactionDisabled ? "true" : "false"}
        aria-label={label}
        // aria-disabled only reflects "session-busy", which is the only situation where there is no click action.
        // The remaining states (ready/error/enabled) are status indicators rather than disabled buttons. Marking disabled together will cause the screen to
        // The reader reads normally ready entries as unavailable. To disable the state, use aria-disabled + click short circuit instead of native disabled.
        // Because native disabled does not trigger hover on most browsers, users will not see the "session in progress" explanation.
        aria-disabled={view.interactionDisabled || undefined}
        onClick={view.clickAction === "open-settings" ? onActivate : undefined}
        className={
          "group/cua h-7 w-fit justify-center gap-1 rounded-lg px-1.5 py-1.5 text-ui-base data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0 " +
          (view.interactionDisabled ? "opacity-50" : "")
        }
      >
        <MonitorCogIcon className="size-4 shrink-0" aria-hidden />
        <span
          className="inline-flex whitespace-nowrap group-data-[composer-compact=true]/cua:hidden"
          data-cua-label
        >
          {label}
        </span>
        {/*
            M7: the status colour dot was removed per a product decision — the entry point does not
            carry status display, the status reading lives on the settings page (opening it starts
            the Helper on demand and reads the real value).
            */}
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerCuaEntry = memo(V4ComposerCuaEntryImpl);
