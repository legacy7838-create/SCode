# Settings: remove the Plugins section

## Goal

Remove the **Plugins** entry and page from the Settings surface completely: no sidebar button
(`settings-section-nav-plugin`), no top-level section. Plugin **execution**, the Plugin Store
overlay, MCP and Skills settings pages are **not** touched — only the Settings surface.

Same pattern as `settings-section-hooks-removal.md` / `settings-section-commands-removal.md`: the
section id is retained for migration while the section is hidden.

## Shape of the feature before removal

`plugin`, `mcp` and `skill` are three sibling Settings sections that all render the **same**
`PluginsSection` component with a `mode` prop:

- `mode="plugin"` — interactive tab bar (plugins / mcps / skills), `PluginList`, plugin detail,
  marketplace breadcrumb,
- `mode="mcp"` / `mode="skill"` — pinned single-capability pages (`fixedTab`).

Removing the `plugin` section therefore does **not** make `PluginsSection` deletable.

## Ownership

| Concern                                               | Owner                                            |
| ----------------------------------------------------- | ------------------------------------------------ |
| Sidebar entry list                                    | `packages/ui/src/settings/settingsPageConfig.ts` |
| Section id visibility / migration / legacy id mapping | `packages/ui/src/lib/settingsNavigation.ts`      |
| Section render + plugin-tab/scope navigation state    | `packages/ui/src/SettingsPage.tsx`               |

## Removed

- `settingsPageConfig.ts`: the `plugin` entry and the now-unused `Blocks` icon import.
- `settingsNavigation.ts`: `"plugin"` added to `HIDDEN_SETTINGS_SECTIONS`; `resolveSettingsSection`
  now maps the retired `"plugins"` market id **before** the visibility check (otherwise the legacy
  id would bypass the hidden check and resolve to an invisible page); the `raw === "plugins"`
  preference migration returns through the same resolver.
- `SettingsPage.tsx`: the `activeSection === "plugin"` branch, the `pluginTab` / `pluginScopeKey`
  state and their pending-intent consumption, and the plugin-tab branch of the section intent
  listener. The `pluginNavigationOrigin` state stays: the header back-button still re-opens the
  Plugin Store when Settings was entered from the store.

## Retained (deliberate)

- `PluginsSection.tsx` — shared live surface for the `mcp` and `skill` sections; its
  `mode="plugin"` branches become unreachable but are kept to avoid destabilizing MCP/Skills
  (the component is the only place hosting `PluginList`, `PluginDetail` and the scope machinery
  that MCP/Skills also use).
- The Plugin Store overlay (`PluginStorePage`, opened from `WorkspaceShellLayout`) and every
  `onOpenPluginStore` entry point inside the MCP/Skills pages — the marketplace stays reachable.
- Plugin runtime (`packages/shared`, `packages/services`, `remotePluginSyncRefresh`,
  `pluginSlashCommandRefresh`).
- i18n keys: `settings.plugins.title` and friends are still used by the MCP/Skills/Plugins
  sub-pages, so no locale cleanup is needed for this removal.

## Acceptance scenarios

1. `createSettingsPageConfig()` contains no section with id `plugin`; the sidebar shows no Plugins
   button (`data-testid="settings-section-nav-plugin"` gone).
2. `resolveSettingsSection("plugin")` and the legacy `resolveSettingsSection("plugins")` both
   return `"general"`; a stored last-section of `plugin`/`plugins` opens General.
3. The `mcp` and `skill` sections still render `PluginsSection` unchanged (typecheck + lint green).
4. Plugin Store still opens from the MCP/Skills pages and from the Settings back-button path.
5. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` stay green; the new unit test
   asserts 1 and 2.
