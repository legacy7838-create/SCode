# ZCode Plugin Store

Domain vocabulary for the plugin settings page and its marketplace browsing/installation experience. This file defines store-related terms uniformly for use by pages, services, and documentation.

## Language

### Marketplace and Sources

**Official Marketplace**:
The sole distribution channel operated by ZCode officially, with marketplace id `zcode-plugins-official`; content = builtin plugins + CDN plugins. It is a "distribution channel" not an "author attribution" — it can include plugins from community authors.
_Avoid_: Using "official" to refer to all trusted marketplaces

**Builtin Plugin**:
Plugins distributed with the app package and seeded into the official marketplace at startup. A subset of official plugins.
_Avoid_: Preinstalled plugins, bundled plugin (colloquially acceptable, documentation uses "builtin")

**CDN Plugin**:
Plugins in the official marketplace distributed as sha256-verified zip packages via the official CDN, downloaded and installed on demand.
_Avoid_: Network plugins, online plugins

**Personal Source**:
All plugin sources added by the user: git/GitHub/URL/local directory marketplaces, inline plugins.
_Avoid_: None

**Catalog Auto-Refresh**:
Throttled background refresh of the Official Marketplace catalog when entering the store page; imperceptible to the user; only covers the official marketplace.
_Avoid_: Mixing with Manual Refresh; calling it "check for updates" (the update badge is merely a byproduct of the refresh)

**Manual Refresh**:
Full marketplace refresh triggered by the refresh button in the store page top bar, not affected by auto-refresh throttling.
_Avoid_: Refresh, check for updates (colloquially acceptable, documentation uses "manual refresh")

### Store Page Structure

**Public Segment**:
One segment of the store list page, showing and only showing the official marketplace catalog (Featured + category blocks).
_Avoid_: Official tab, store tab

**Personal Segment**:
The other segment of the store list page, showing all personal source catalogs, grouped by marketplace.
_Avoid_: Third-party tab, My tab

**Featured**:
The curation area at the top of the Public Segment, with the list remotely controlled by the `featured` field in the official CDN catalog. Only exists in the Public Segment.
_Avoid_: Mixing with Recommended

**Installed Strip**:
A row of installed plugin icons at the top of the list page; clicking an icon enters the detail page.
_Avoid_: Installed list (that is the Manage Installed view's concern)

**Manage Installed View**:
The management interface entered via the gear icon on the right of the installed strip, hosting plugin-level enable/disable toggles, updates, uninstalls, and enabled-status filtering.
_Avoid_: Installed tab (old IA term, deprecated)

### Metadata

**Store Listing**:
Display metadata carried by catalog entries: display name, icon, category, developer, website/privacy policy/terms of service links, hero image, example prompts. Describes "how it is presented in the store"; does not affect plugin functionality.
_Avoid_: Plugin metadata (vague, may refer to manifest)

**Plugin Manifest**:
The functional definition in `plugin.json` within the plugin package (commands/agents/skills/hooks/mcpServers/userConfig…). Describes "what the plugin is and does".
_Avoid_: marketplace.json (that is the catalog, not the manifest)

**Example Prompt**:
Clickable prompts provided by the Store Listing; clicking creates a new session and pre-fills (does not auto-send). The only "new session" entry point on the detail page.
_Avoid_: Quick command, prompt template, try now

### Lifecycle States

**Plugin Lifecycle**:
The complete product path from when a user discovers a plugin, through viewing, installing, configuration, enabling/disabling, using, checking for updates, upgrading, and persistence recovery, until uninstalling or restoring a builtin plugin. Each stage must verify both the visible UI state and the corresponding persistence or runtime results.
_Avoid_: Calling only "installation success" the complete lifecycle

**Restorable Builtin**:
A Builtin Plugin that was uninstalled by the user and has entered a persistent suppressed state. App restart must not automatically re-seed it; it continues to appear in the Public Segment and performs a clean recovery through the "Install" entry.
_Avoid_: Uninstalled CDN plugin, temporarily disabled builtin plugin

**Orphaned Installed Plugin**:
A plugin whose corresponding Personal Source has been deleted, but whose installation directory and user data are still retained. It can still be used, configured, enabled/disabled, and uninstalled; it cannot be updated until the source is re-added; re-adding the same source restores catalog association.
_Avoid_: Broken install, missing manifest, uninstalled plugin
