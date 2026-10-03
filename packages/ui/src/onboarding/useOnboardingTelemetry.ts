import { useCallback, useLayoutEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { OccupationValue } from "@/onboarding/occupationOptions.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

const workDirections: Record<OccupationValue, string> = {
  developer: "software_data_ai",
  independent: "entrepreneurship_freelance_opc",
  infrastructure: "qa_operations_security",
  product: "product_project_solutions",
  design: "ui_ux_visual_design",
  student: "education_research",
  finance: "finance_accounting_consulting",
  creator: "media_content_creation",
  operations: "business_operations_ecommerce_customer_service",
  marketing: "marketing_brand_pr",
  legal: "legal_administration_hr",
  other: "other",
};

type ExitAction = "start" | "skip" | "close";
type Exposure = {
  ended: boolean;
  modeVisited: boolean;
  preferencesVisited: boolean;
  mode: InterfaceMode | null;
  preferenceValues: string;
};

/**
 * The business choice is still owned by the onboarding component; this only records the range
 * actually shown this time and de-duplicates the reporting.
 */
export function useOnboardingTelemetry({
  platform,
  visible,
  step,
  occupation,
  mode,
  suggestions,
  migration,
}: {
  platform: Pick<IPlatformService, "reportTelemetryEvent">;
  visible: boolean;
  step: 0 | 1 | 2;
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  suggestions: boolean;
  migration: boolean;
}) {
  const exposure = useRef<Exposure | null>(null);
  useLayoutEffect(() => {
    if (!visible) {
      exposure.current = null;
      return;
    }
    const preferenceValues = `${suggestions}:${migration}`;
    if (!exposure.current) {
      exposure.current = {
        ended: false,
        modeVisited: false,
        preferencesVisited: false,
        mode,
        preferenceValues,
      };
      void reportAppTelemetryEvent(
        platform,
        {
          elementName: "onboarding_expose",
          eventRegion: "app.onboarding",
          eventType: "expose",
          eventText: "",
          eventExtraDetail: {},
        },
        "onboardingTelemetry",
      );
    }
    const current = exposure.current;
    // After returning to the changed mode, the old preferences no longer represent the options the user sees; switching back to the original mode must also display the third page again.
    if (current.mode !== mode || (step !== 2 && current.preferenceValues !== preferenceValues)) {
      current.preferencesVisited = false;
    }
    current.preferenceValues = preferenceValues;
    current.mode = mode;
    if (step === 1) current.modeVisited = true;
    if (step === 2) current.preferencesVisited = true;
    // Not reset in cleanup: StrictMode effect replay is not a new product exposure.
  }, [visible, step, mode, platform, suggestions, migration]);

  return useCallback(
    (action: ExitAction, eventText: string) => {
      const current = exposure.current;
      const detail = {
        work_direction: occupation ? workDirections[occupation] : "null",
        ui_mode: current?.modeVisited && mode ? (mode === "office" ? "work" : "code") : "null",
        proactive_task_recommendations_enabled:
          current?.preferencesVisited && mode === "office" ? String(suggestions) : "null",
        claude_code_history_migration_selected: current?.preferencesVisited
          ? String(migration)
          : "null",
        exit_action: action,
        exit_step: String(step + 1),
      };
      // Freezes the text and answers when clicked; it is only called after successful saving, and the settings/record overwritten by skip are not read.
      return () => {
        if (!current || current.ended || exposure.current !== current) return;
        current.ended = true;
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "onboarding_end",
            eventRegion: "app.onboarding",
            eventType: "ck",
            eventText,
            eventExtraDetail: detail,
          },
          "onboardingTelemetry",
        );
      };
    },
    [platform, occupation, mode, suggestions, migration, step],
  );
}
