import { useState, type ReactNode } from "react";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

/**
 * Workspace Automations do not go through SettingsPage, and the edit page's breadcrumb reporting
 * needs a Provider to receive it, so the desktop top bar is left with only an empty drag region;
 * this lets the workspace entry point reuse the settings page's breadcrumb contract as-is.
 */
export function AutomationsMainBreadcrumbFrame({
  ariaLabel,
  children,
  isDesktop,
  sectionLabel,
}: {
  ariaLabel: string;
  children: ReactNode;
  isDesktop: boolean;
  sectionLabel: string;
}) {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);

  return (
    <SettingsBreadcrumbProvider onItemsChange={setItems} sectionLabel={sectionLabel}>
      <div className="flex min-h-0 flex-1 flex-col">
        {isDesktop ? (
          <div
            className="h-12 shrink-0 [app-region:drag]"
            data-testid="automations-main-drag-region"
          >
            <SettingsHeaderBreadcrumb ariaLabel={ariaLabel} items={items} />
          </div>
        ) : null}
        {children}
      </div>
    </SettingsBreadcrumbProvider>
  );
}
