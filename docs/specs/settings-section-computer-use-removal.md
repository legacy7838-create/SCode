# Settings: remove the Computer Use section

## Goal

Remove the **Computer Use** entry and page from the Settings surface completely: no sidebar button
(`settings-section-nav-computerUse`), no section page, no section-only helpers left behind. The
Computer Use _feature_ (CUA runtime, permission onboarding, the composer entry, the `zcode-cua`
package) is **not** touched — only the Settings surface.

Same migration pattern as the Hooks / Commands / Plugins / Browser removals. Note: the `"computerUse"`
id was already in `HIDDEN_SETTINGS_SECTIONS` before this change (the page never rendered for this
build); this removal deletes the remaining config entry, render branch, component and plumbing so
nothing references the page anymore.

## Ownership

| Concern                             | Owner                                            |
| ----------------------------------- | ------------------------------------------------ |
| Sidebar entry list + desktop gating | `packages/ui/src/settings/settingsPageConfig.ts` |
| Section id visibility / migration   | `packages/ui/src/lib/settingsNavigation.ts`      |
| Section render                      | `packages/ui/src/SettingsPage.tsx`               |

## Removed

- `settingsPageConfig.ts`: the `computerUse` entry (and the stale "Computer control follows browser"
  comment), the `SettingsPageConfigOptions` desktop-gating interface (`isDesktop` / `isMacDesktop` /
  `isWindowsDesktop` were only consumed by `showComputerUse`), the `showComputerUse` branch, and the
  now-dead `section.id !== "computerUse"` clause of the `SETTINGS_SECTIONS` export filter. `Monitor`
  stays — the theme picker still uses it.
- `SettingsPage.tsx`: the `ComputerUseSection` import, the `activeSection === "computerUse"` branch
  (the last branch before `: null`), the desktop arguments passed to `createSettingsPageConfig`, and
  the stale Grayscale example in the section-fallback comment.
- Deleted files: `settings/ComputerUseSection.tsx` plus its two now-exclusive helpers
  `settings/pluginEnabledChange.ts` and `settings/cuaPermissionRestartVerify.ts`.
- i18n: the nine `settings.computerUse.*` keys that had no user outside the deleted component
  (`disabledToast`, `toggleLabel`, `toggleDescription`, `composerEntry.*`, `pluginDisabledHint`,
  `unsupported.title`). The five keys still used by `PluginsSection`'s "Unavailable built-in
  capabilities" card (`title`, `unsupported.group`, `unsupported.badge`,
  `unsupported.linuxDescription`, `unsupported.remoteDescription`) stay.

## Retained (deliberate)

- CUA runtime and shared helpers that other surfaces use: `computerUseAvailability`,
  `cuaPermissionAction`, `cuaPermissionPreparation`, `cuaPermissionOnboardingOperation`,
  `useCuaPermissionStatus`, `cuaPlatform`, `StatusDot`, `pluginManagementStore`.
- `useCuaComposerEntry`: its `clickAction === "open-settings"` intent still fires
  `setPendingSettingsSectionIntent("computerUse")`; with the id hidden it degrades to the General
  page (same graceful degradation as the Hooks banner intent).

## Acceptance scenarios

1. `createSettingsPageConfig()` contains no section with id `computerUse`, and it takes no arguments.
2. `resolveSettingsSection("computerUse")` returns `"general"`; a stored last-section of
   `computerUse` opens General.
3. No source file imports `ComputerUseSection`, `pluginEnabledChange` or
   `cuaPermissionRestartVerify`.
4. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` stay green; the new unit test
   asserts 1 and 2.
