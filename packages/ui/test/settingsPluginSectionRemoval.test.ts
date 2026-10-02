import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";

/**
 * The Plugins page was removed from the Settings surface while its section id (and the retired
 * plugin-market id that maps onto it) stays valid only for migration
 * (docs/specs/settings-section-plugin-removal.md), so stored preferences and intents degrade to the
 * fallback instead of rendering an unreachable page.
 */

test("the Plugins section is not part of the settings sidebar", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  assert.equal(
    settingsSections.some((section) => section.id === "plugin"),
    false,
    "the sidebar entry list must not contain the plugin page",
  );
  for (const group of settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "plugin"),
      false,
      `group ${group.id} must not contain the plugin page`,
    );
  }
  // The sibling MCP / Skills sections share PluginsSection and must survive.
  assert.ok(settingsSections.some((section) => section.id === "mcp"));
  assert.ok(settingsSections.some((section) => section.id === "skill"));
});

test("plugin section ids degrade to the fallback", () => {
  assert.equal(isSettingsSectionEnabled("plugin"), false);
  assert.equal(resolveSettingsSection("plugin"), "general");
  // The retired market id maps onto the plugin page id *before* the visibility check, so it must
  // not bypass the hidden section.
  assert.equal(resolveSettingsSection("plugins"), "general");
  assert.equal(resolveSettingsSection("plugin", "modelProvider"), "modelProvider");
  assert.equal(
    resolveSettingsSectionForPlatform("plugin", createSettingsPageConfig().settingsSections),
    "general",
  );
  // Unrelated sections keep their behavior.
  assert.equal(resolveSettingsSection("mcp"), "mcp");
  assert.equal(isSettingsSectionEnabled("mcp"), true);
});
