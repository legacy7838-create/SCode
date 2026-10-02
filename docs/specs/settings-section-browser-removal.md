# Settings: remove the Browser Use section

## Goal

Remove the **Browser Use** entry and page from the Settings surface completely: no sidebar button
(`settings-section-nav-browser`), no section page, no leftover section-only components. The
browser runtime (Embedded Browser pane, the `browser-use-plugin`, Chrome data import services) is
**not** touched — only the Settings surface.

Same migration pattern as the Hooks / Commands / Plugins removals: the section id is retained while
the section is hidden.

## Ownership

| Concern                             | Owner                                            |
| ----------------------------------- | ------------------------------------------------ |
| Sidebar entry list                  | `packages/ui/src/settings/settingsPageConfig.ts` |
| Section id visibility / migration   | `packages/ui/src/lib/settingsNavigation.ts`      |
| Section render + section-only state | `packages/ui/src/SettingsPage.tsx`               |

## Removed UI files

- `packages/ui/src/settings/BrowserSettingsSection.tsx` (only imported by `SettingsPage`)
- `packages/ui/src/settings/browserImportSummary.ts` (only imported by `BrowserSettingsSection`)

Removed from `SettingsPage.tsx`:

- the `BrowserSettingsSection` import and the `activeSection === "browser"` branch,
- the `embeddedBrowserAllowInsecureCertificates` state, its settings-load assignment and the
  `handleEmbeddedBrowserAllowInsecureCertificatesChange` callback (all three existed only to feed
  that branch; the AppSettings field itself stays, so the runtime preference keeps working).

## Retained on purpose

- The `embeddedBrowserAllowInsecureCertificates` AppSettings field and everything that reads it
  (the certificate policy is applied by the session runtime at startup).
- The Embedded Browser pane, `browser-use-plugin`, and every other browser surface.
- The `"browser"` id in `SettingsSectionId` (no deep-link caller sends it today; keeping the id
  makes any future/legacy intent degrade through the hidden-section fallback instead of failing).

## i18n

Keys referenced only by the removed files (`settings.browser.*`, `settings.embeddedBrowser*`) are
removed from `en-US.ts` after re-verifying zero remaining references.

## Acceptance scenarios

1. `createSettingsPageConfig()` contains no section with id `browser`; the sidebar shows no
   Browser Use button (`data-testid="settings-section-nav-browser"` gone).
2. `resolveSettingsSection("browser")` returns `"general"`; a stored last-section of `browser`
   opens General.
3. No source file imports `BrowserSettingsSection` / `browserImportSummary`; `toast` and the other
   `SettingsPage` imports stay used.
4. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` stay green; the new unit test
   asserts 1 and 2.
