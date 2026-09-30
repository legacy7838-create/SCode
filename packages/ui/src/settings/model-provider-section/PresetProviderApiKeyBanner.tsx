import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PresetProviderApiKeyBanner({ onOpenApiKey }: { onOpenApiKey: () => void }) {
  const { intl } = useZCodeIntl();

  // Access portals do not distinguish between individuals/teams; two buttons and dedicated fields deviate from the expectation of a single console portal.
  return (
    <div className="text-foreground-subtlest flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-ui-base">
      <button
        type="button"
        className="text-primary cursor-pointer rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onOpenApiKey}
      >
        {intl.formatMessage({ id: "settings.modelProvider.getApiKey" })}
      </button>
    </div>
  );
}
