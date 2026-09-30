import { useOnboardingTelemetry } from "@/onboarding/useOnboardingTelemetry.js";
import { OnboardingHeader } from "@/onboarding/OnboardingHeader.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { occupations, type OccupationValue } from "@/onboarding/occupationOptions.js";
import { OnboardingModeSelector } from "@/onboarding/OnboardingModeSelector.js";
import { OnboardingOccupationGrid } from "@/onboarding/OnboardingOccupationGrid.js";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import type { OnboardingRecordEntry } from "@zcode/shared";

/** Append the local boot record (userId is completed by host); when the channel is missing and suspended, the 5-second timeout will be handled as a write failure. */
async function appendOnboardingRecord(
  service: NonNullable<ReturnType<typeof useOnboardingRecordService>>,
  deviceMid: string,
  entry: Parameters<typeof service.appendRecord>[1],
): Promise<void> {
  await Promise.race([
    service.appendRecord(deviceMid, entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error("appendRecord timeout")), 5000)),
  ]);
}

export function OccupationOnboarding({
  children,
  showWindowControls = false,
  showChildrenWhileLoading = false,
  isMacDesktop,
  isWindowsDesktop,
}: {
  children: ReactNode;
  /** Windows/Linux self-drawn window control: guide full-screen coverage of the main interface (including title bar), where you need to minimize/maximize/close. */
  showWindowControls?: boolean;
  /** The independent settings page does not rely on boot settings to load, preventing the application-level boot outer layer from blocking the settings content. */
  showChildrenWhileLoading?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const onboardingRecord = useOnboardingRecordService();
  const shortcutBindings = useEffectiveShortcutBindings();
  const requested = useZCodeStore((state) => state.newUserOnboardingOpen);
  const setRequested = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // When the login status changes (useRootOAuthEffects setUser after successful login), press userId to re-determine whether to trigger booting.
  const userId = useZCodeStore((state) => state.user?.id) ?? null;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `occupationOnboarding.${key}` });
  const [occupation, setOccupation] = useState<OccupationValue | null>("developer");
  const savedInterfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  // A mode of null means that the mode page was "skipped" (skipping is an explicit answer, and null is retained in the record rather than a blanket value).
  const [mode, setMode] = useState<InterfaceMode | null>(savedInterfaceMode);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const preferences = step === 2;
  const requestOnboardingDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const [migration, setMigration] = useState(false);
  const [memory, setMemory] = useState(savedInterfaceMode === "office");
  const [suggestions, setSuggestions] = useState(savedInterfaceMode === "office");
  const suggestionsEditedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const loadDeviceMid = useCallback(() => platform.getDeviceId(), [platform]);
  const [needsOnboarding, markOnboarded] = useOnboardingTrigger({
    onboardingRecord,
    userId,
    hasStoredOccupation: Boolean(settings?.onboardingOccupation),
    loadDeviceMid,
    update,
  });
  const onboardingVisible = requested || (needsOnboarding === true && !dismissed);
  const captureEnd = useOnboardingTelemetry({
    platform,
    visible:
      Boolean(settings) &&
      onboardingVisible &&
      (requested || needsOnboarding !== null || Boolean(settings?.onboardingOccupation)),
    step,
    occupation,
    mode,
    memory,
    suggestions,
    migration,
  });
  const closeOnboarding = useCallback(() => {
    if (savingRef.current) return;
    captureEnd("close", intl.formatMessage({ id: "occupationOnboarding.close" }))();
    setStep(0);
    setDismissed(true);
    setRequested(false);
    if (onboardingRecord) {
      void onboardingRecord.dismissOnboarding(platform.getDeviceId()).catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] failed to persist close decision", {
          error: String(cause),
        });
      });
    }
  }, [captureEnd, intl, onboardingRecord, platform, setRequested]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shortcutBindings.toggleInterfaceMode.some((binding) =>
          matchesShortcutBinding(event, binding),
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        const nextMode = savedInterfaceMode === "office" ? "coding" : "office";
        setInterfaceMode(nextMode);
        setMode(nextMode);
        if (nextMode !== mode) {
          setMemory(nextMode === "office");
          if (nextMode === "office" && !suggestionsEditedRef.current) setSuggestions(true);
        }
        return;
      }
      if (event.key === "Escape" && onboardingVisible && !saving) {
        // Exit directly without changing your preferences; the first boot will be persisted and dismissed to avoid repeated display next time.
        event.preventDefault();
        event.stopImmediatePropagation();
        closeOnboarding();
        return;
      }
      if (
        !shortcutBindings.openOnboarding.some((binding) => matchesShortcutBinding(event, binding))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving) return;
      // Turning off debug booting does not save preferences and does not mark the first boot as complete.
      if (onboardingVisible) {
        closeOnboarding();
      } else {
        setRequested(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    closeOnboarding,
    shortcutBindings,
    setRequested,
    onboardingVisible,
    saving,
    savedInterfaceMode,
    setInterfaceMode,
    mode,
  ]);
  // When the guide is opened again (triggered by changing accounts/manually opened by shortcut keys), the user's most recent answers in the record will be used to prefill.
  // Rather than starting with a hard-coded default option every time; skipping pages and setting null fields to their default values.
  const [latestEntry, setLatestEntry] = useState<OnboardingRecordEntry | null>(null);
  // Prefilling asynchronously will not overwrite selections already made by the user.
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (!onboardingRecord) return;
    let cancelled = false;
    onboardingRecord.getLatestEntry().then(
      (entry) => {
        if (!cancelled) setLatestEntry(entry);
      },
      (cause) => {
        logger.warn("[occupation-onboarding] failed to read prefilled answers", {
          error: String(cause),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onboardingRecord, userId]);
  const markUserEdited = () => {
    userEditedRef.current = true;
  };

  const applyLatestEntry = () => {
    const entry = latestEntry;
    setStep(0);
    setOccupation(
      entry?.occupation && (occupations as readonly string[]).includes(entry.occupation)
        ? (entry.occupation as OccupationValue)
        : "developer",
    );
    const initialMode = entry?.interfaceMode ?? savedInterfaceMode;
    setMode(initialMode);
    // Programming mode turns off active working memory by default; office mode only restores the user's previous check.
    setMemory(initialMode === "office" && (entry?.memoryEnabled ?? true));
    setSuggestions(entry?.proactiveSuggestionsEnabled ?? initialMode === "office");
    setMigration(false);
    setError(false);
  };
  useEffect(() => {
    if (!requested) return;
    userEditedRef.current = false;
    suggestionsEditedRef.current = false;
    applyLatestEntry();
    // If latestEntry arrives asynchronously, if the guide is already open, it will be prefilled again (the default value will be overwritten before the user interacts).
  }, [requested]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onboardingVisible || userEditedRef.current) return;
    applyLatestEntry();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [latestEntry]);
  if (!settings) return showChildrenWhileLoading ? <>{children}</> : null;
  // Do not render while the judgment is in progress to avoid the boot flashing and then disappearing immediately (it is judged that booting is required) or the booting flashes first and then enters the main interface.
  // Only those who are suspected of being the first runner (there is no profession in the settings) are waiting for record determination; existing users (who already have
  // onboardingOccupation) directly enters the main interface without waiting for RPC to prevent a black screen.
  if (!requested && needsOnboarding === null && !settings.onboardingOccupation) return null;
  if (!onboardingVisible) return <>{children}</>;
  const save = async (skip = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const reportEnd = captureEnd(skip ? "skip" : "start", t(skip ? "skip" : "start"));
    setSaving(true);
    setError(false);
    try {
      if (mode) setInterfaceMode(mode);
      logger.info("[occupation-onboarding] saving preferences", { interfaceMode: mode });
      await update({
        // The settings side maintains the existing semantics: skipping conservative default values (career other/preference level),
        // The distinction of "skipping counts as an answer" is only reflected in onboarding-record.json.
        onboardingOccupation: occupation ?? "other",
        memoryEnabled: skip ? false : memory,
        proactiveSuggestionsEnabled: !skip && mode === "office" && suggestions,
      });
      reportEnd();
      // Successful saving is the end of this boot; failure of local recording should not leave a boot page that can be reported again.
      setStep(0);
      setDismissed(true);
      setRequested(false);
      if (!skip && migration) requestOnboardingDialog("migration");
      logger.info("[occupation-onboarding] preferences saved", { interfaceMode: mode });
      if (onboardingRecord) {
        try {
          // Append the local boot record (userId is completed by host according to the login status), and then upload it to the server.
          // appendRecord uses RPC. When the channel is missing, it will hang and cause the save button to spin forever, adding timeout protection.
          // Skip is the explicit answer: null when the page is skipped (occupation was already null when skipped in step 1,
          // mode is set to null if step 2 is skipped, and two booleans are set to null if the entire preference page is skipped).
          await appendOnboardingRecord(onboardingRecord, platform.getDeviceId(), {
            occupation,
            interfaceMode: mode,
            memoryEnabled: skip ? null : memory,
            proactiveSuggestionsEnabled: skip ? null : mode === "office" && suggestions,
            completedAt: new Date().toISOString(),
          });
          markOnboarded();
        } catch (cause) {
          // The preference has been saved successfully. If the record fails to be written, only the warn log will be left, without interrupting the user; pressing record will trigger the boot again at the next startup.
          logger.warn("[occupation-onboarding] failed to append onboarding record", {
            error: String(cause),
          });
        }
      }
    } catch (cause) {
      logger.warn("[occupation-onboarding] failed to save preferences", { error: String(cause) });
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <main
      aria-label={t("title")}
      data-testid="onboarding-page"
      className="relative flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 [app-region:drag]" />
      {/* Same as Settings, including Workspace's 4px outer margin, 1px border and 8px padding. */}
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-1 lg:p-1">
        <div className="flex min-h-0 flex-col pt-12 [@media(max-height:740px)]:pt-10">
          <OnboardingHeader
            step={step}
            saving={saving}
            t={t}
            onBack={() => setStep(step === 2 ? 1 : 0)}
            onClose={closeOnboarding}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-10">
            {/* Automatic margins center short content, and long content scrolls normally from the top, without affecting fixed navigation. */}
            <div className="mx-auto my-auto w-full max-w-lg shrink-0">
              <section className="flex w-full flex-col">
                <div className="w-full">
                  <h1 className="text-ui-xl font-semibold tracking-tight text-center">
                    {t(preferences ? "preferences" : step === 1 ? "modeTitle" : "title")}
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
                    {t(
                      preferences
                        ? "preferencesDescription"
                        : step === 1
                          ? "modeDescription"
                          : "description",
                    )}
                  </p>
                  {step === 1 ? (
                    <OnboardingModeSelector
                      mode={mode}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        // Re-selecting the current programming mode should also clear the default check from the old record.
                        setMemory(value === "office");
                        if (value !== mode) {
                          if (value === "office" && !suggestionsEditedRef.current)
                            setSuggestions(true);
                        }
                        setMode(value);
                      }}
                      label={t("modeTitle")}
                      formatLabel={(key) => t(key)}
                    />
                  ) : preferences ? (
                    <div className="mt-8 space-y-3">
                      {(["suggestions", "memory", "migration"] as const)
                        .filter((key) => key !== "suggestions" || mode === "office")
                        .map((key) => (
                          <label
                            key={key}
                            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
                          >
                            <Checkbox
                              checked={
                                key === "migration"
                                  ? migration
                                  : key === "memory"
                                    ? memory
                                    : suggestions
                              }
                              disabled={saving}
                              onCheckedChange={(checked) => {
                                markUserEdited();
                                if (key === "migration") setMigration(checked === true);
                                else if (key === "memory") setMemory(checked === true);
                                else {
                                  suggestionsEditedRef.current = true;
                                  setSuggestions(checked === true);
                                }
                              }}
                            />
                            <span className="font-medium">{t(key)}</span>
                            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
                              {t(`${key}Description`)}
                            </span>
                          </label>
                        ))}
                    </div>
                  ) : (
                    <OnboardingOccupationGrid
                      occupation={occupation}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        setOccupation(value);
                      }}
                      label={t("title")}
                      formatLabel={(value) => t(value)}
                    />
                  )}
                  {error ? (
                    <p role="alert" className="mt-4 text-ui-sm text-destructive">
                      {t("error")}
                    </p>
                  ) : null}
                </div>
                <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
                  <Button
                    variant="link"
                    disabled={saving}
                    className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
                    onClick={() => {
                      markUserEdited();
                      if (preferences) void save(true);
                      else {
                        if (step === 0) setOccupation(null);
                        else setMode(null);
                        setStep(step === 0 ? 1 : 2);
                      }
                    }}
                  >
                    {t("skip")}
                  </Button>
                  <div className="flex w-full gap-3">
                    <Button
                      disabled={saving || (step === 0 && !occupation)}
                      className="h-11 flex-1 rounded-xl px-5 text-ui-base"
                      onClick={() => {
                        if (!preferences) setStep(step === 0 ? 1 : 2);
                        else void save();
                      }}
                    >
                      {t(saving ? "saving" : preferences ? "start" : "continue")}
                    </Button>
                  </div>
                </footer>
              </section>
            </div>
          </div>
        </div>
        <OccupationOnboardingVisual
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
        />
      </div>
    </main>
  );
}
