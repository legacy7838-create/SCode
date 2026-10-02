# Settings: remove the Commands section

## Goal

Remove the **Commands** entry and page from the Settings surface completely: no sidebar button
(`settings-section-nav-commands`), no top-level section, no unreachable editor components left
behind. Slash-command **execution** (chat, mentions, palette, plugin sync) is untouched — only the
Settings surface goes.

Same pattern as `settings-section-hooks-removal.md`: the section id is retained for migration while
the section is hidden.

## Ownership

| Concern                                         | Owner                                            |
| ----------------------------------------------- | ------------------------------------------------ |
| Sidebar entry list                              | `packages/ui/src/settings/settingsPageConfig.ts` |
| Section id visibility / migration               | `packages/ui/src/lib/settingsNavigation.ts`      |
| Section render                                  | `packages/ui/src/SettingsPage.tsx`               |
| Section composition (the `mode="command"` page) | `packages/ui/src/settings/PluginsSection.tsx`    |

## Shape of the feature before removal

The top-level `commands` section rendered `<PluginsSection mode="command">`, which pinned the tab
bar to `fixedTab = "commands"` and rendered `CommandsSection` inside its `Tabs`. The interactive
plugin tab set (`PluginTab = Exclude<PluginTabTarget, "commands">`) never contained commands, so
removing the `mode="command"` entry point makes `CommandsSection` (and its `CommandCard`,
`CommandForm`, `commandWorkspaceScope`) unreachable.

## Removed UI files

- `packages/ui/src/settings/CommandsSection.tsx`
- `packages/ui/src/settings/CommandCard.tsx`
- `packages/ui/src/settings/CommandForm.tsx`
- `packages/ui/src/settings/commandWorkspaceScope.ts` (only imported by `CommandsSection`)

Kept on purpose:

- `ExternalAgentImportDialog.tsx` (+ its `CommandsImportDialog` export only if still referenced —
  otherwise trimmed) — shared with Onboarding, MCP and Skills.
- `pluginSlashCommandRefresh.ts` — used by `remotePluginSyncRefresh`.
- `useCommands`, command palette scopes, mention categories, onboarding imports — chat-side
  slash-command surfaces, unrelated to Settings.
- Everything under `packages/shared` / `packages/services` — command runtime unchanged.

## Section id retained, section hidden

`"commands"` stays in `SettingsSectionId` (and in `SettingsPluginTabTarget`, whose legacy
`normalizePluginTab("commands") -> "plugins"` mapping must keep parsing stored intent values) and is
added to `HIDDEN_SETTINGS_SECTIONS`, so `resolveSettingsSection("commands")` degrades to the
fallback. `SettingsPage` drops the `activeSection === "commands"` branch; `PluginsSection` drops its
`mode="command"` type, `fixedTab` mapping, command editor state and its `TabsContent`.

## i18n

The `settings.commands.*` keys and `settings.plugin.tab.commands` become unused and are removed
from `en-US.ts`; `settings.plugins.store.section.commands` (plugin store detail, different surface)
stays.

## Acceptance scenarios

1. `createSettingsPageConfig()` contains no section with id `commands`; the sidebar shows no
   Commands button (`data-testid="settings-section-nav-commands"` gone).
2. `resolveSettingsSection("commands")` returns the fallback (`general`).
3. No source file imports `CommandsSection`/`CommandCard`/`CommandForm`, and `mode="command"` is
   gone from `PluginsSection`.
4. `useCommands`, the command palette and plugin sync still compile; command runtime in
   `packages/shared`/`packages/services` is byte-identical.
5. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` stay green; the new unit test
   asserts 1 and 2.
