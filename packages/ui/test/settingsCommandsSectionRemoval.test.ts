import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";

/**
 * The Commands page was removed from the Settings surface while its section id stays valid only
 * for migration (docs/specs/settings-section-commands-removal.md), so stored preferences and
 * legacy plugin-tab intents must degrade to the fallback instead of rendering a ghost section.
 */

test("the Commands section is not part of the settings sidebar", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  assert.equal(
    settingsSections.some((section) => section.id === "commands"),
    false,
    "the sidebar entry list must not contain commands",
  );
  for (const group of settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "commands"),
      false,
      `group ${group.id} must not contain commands`,
    );
  }
  assert.ok(settingsSections.length > 0, "the sidebar must still have sections");
});

test("a commands section intent or stored preference degrades to the fallback", () => {
  assert.equal(isSettingsSectionEnabled("commands"), false);
  assert.equal(resolveSettingsSection("commands"), "general");
  assert.equal(resolveSettingsSection("commands", "modelProvider"), "modelProvider");
  assert.equal(
    resolveSettingsSectionForPlatform("commands", createSettingsPageConfig().settingsSections),
    "general",
  );
  // Unrelated sections keep their behavior.
  assert.equal(resolveSettingsSection("mcp"), "mcp");
  assert.equal(isSettingsSectionEnabled("mcp"), true);
});
