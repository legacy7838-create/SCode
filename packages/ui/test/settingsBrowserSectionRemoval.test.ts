import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";

/**
 * The Browser Use page was removed from the Settings surface while its section id stays valid only
 * for migration (docs/specs/settings-section-browser-removal.md), so a stored preference degrades to
 * the fallback instead of rendering an unreachable page.
 */

test("the Browser Use section is not part of the settings sidebar", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  assert.equal(
    settingsSections.some((section) => section.id === "browser"),
    false,
    "the sidebar entry list must not contain browser",
  );
  for (const group of settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "browser"),
      false,
      `group ${group.id} must not contain browser`,
    );
  }
  // Sibling basic sections must survive.
  assert.ok(settingsSections.some((section) => section.id === "general"));
  assert.ok(settingsSections.some((section) => section.id === "appearance"));
});

test("a browser section intent or stored preference degrades to the fallback", () => {
  assert.equal(isSettingsSectionEnabled("browser"), false);
  assert.equal(resolveSettingsSection("browser"), "general");
  assert.equal(resolveSettingsSection("browser", "modelProvider"), "modelProvider");
  assert.equal(
    resolveSettingsSectionForPlatform("browser", createSettingsPageConfig().settingsSections),
    "general",
  );
  // Unrelated sections keep their behavior.
  assert.equal(resolveSettingsSection("general"), "general");
  assert.equal(isSettingsSectionEnabled("general"), true);
});
