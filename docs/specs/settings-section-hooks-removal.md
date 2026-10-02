# Settings: remove the Hooks section

## Goal

Remove the **Hooks** entry and page from the Settings surface completely: no sidebar button, no
section content, no leftover components. The runtime hooks subsystem (protocol, services, hook
review commands, chat-surface banners) is **not** touched — only the Settings UI surface.

## Ownership

| Concern                           | Owner                                                |
| --------------------------------- | ---------------------------------------------------- |
| Sidebar entry list                | `packages/ui/src/settings/settingsPageConfig.ts`     |
| Section id visibility / migration | `packages/ui/src/lib/settings/settingsNavigation.ts` |
| Section render                    | `packages/ui/src/SettingsPage.tsx`                   |

## Removed UI files

- `packages/ui/src/settings/HooksSection.tsx` (only imported by `SettingsPage`)
- `packages/ui/src/settings/HooksList.tsx` (only imported by `HooksSection`)
- `packages/ui/src/settings/HookForm.tsx` (only imported by `HooksSection`)
- `packages/ui/src/settings/WorkspaceHookTrustNotice.tsx` (only imported by `HooksList`/`HooksSection`)
- `packages/ui/src/settings/useWorkspaceHookInlineTrust.ts` (only imported by `HooksSection`)
- `packages/ui/src/settings/workspaceHookTrustState.ts` (only imported by the inline-trust hook)
- `packages/ui/src/store/hooksStore.ts` (only imported by the two files above)

Kept on purpose:

- `packages/ui/src/settings/workspaceHookReviewCommands.ts` — used by
  `v4/WorkspaceHookPendingBanner.tsx`, so hook approve/reject from the chat banner keeps working.
- Everything under `packages/shared`, `packages/services` and the agent runtime — hook execution and
  trust gating are unchanged.

## Section id retained, section hidden

`"hooks"` stays in the `SettingsSectionId` union (same migration pattern the repository already
uses for the retired `plugins` market id): stored preferences, one-shot intents and protocol
carried jumps (`workspace-hook-review` sends `settingsSection: "hooks"`) must keep parsing and then
degrade instead of crashing. `"hooks"` is added to `HIDDEN_SETTINGS_SECTIONS`, so:

- `isSettingsSectionEnabled("hooks")` is false -> filtered out of the sidebar by config.
- `resolveSettingsSection("hooks")` returns the fallback (`general`), which also migrates a stale
  `zcode-settings-last-section` preference the next time it is written.

## Flagged behavior change

- `v4/WorkspaceHookPendingBanner.tsx` still issues the "hooks" section intent; it now opens
  Settings on **General**. Hook approve/reject stays available inline in that banner
  (`sendWorkspaceHookCommand`), so the review flow is not blocked — only the settings page for
  editing hooks is gone.
- The `settings.hooks.*` i18n keys become unused and are removed from `en-US.ts`.

## Acceptance scenarios

1. `createSettingsPageConfig()` contains no section with id `hooks`; the sidebar shows no Hooks
   button (`data-testid="settings-section-nav-hooks"` gone).
2. `resolveSettingsSection("hooks")` returns `"general"`; a stored last-section of `"hooks"` opens
   General.
3. `SettingsPage` has no `HooksSection` import/branch and the `hooks-settings-section` test id no
   longer exists in source.
4. `workspaceHookReviewCommands` and `WorkspaceHookPendingBanner` still compile; hook runtime in
   `packages/shared`/`packages/services` is byte-identical.
5. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` stay green; the new unit test
   asserts 1 and 2.
