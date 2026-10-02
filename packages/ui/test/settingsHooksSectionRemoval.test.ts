import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";

/**
 * The Hooks page was removed from the Settings surface while its section id stays valid only for
 * migration (docs/specs/settings-section-hooks-removal.md), so stored preferences, one-shot intents
 * and protocol-carried jumps must degrade to the fallback instead of rendering a ghost section.
 */

test("the Hooks section is not part of the settings sidebar", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  assert.equal(
    settingsSections.some((section) => section.id === "hooks"),
    false,
    "the sidebar entry list must not contain hooks",
  );
  for (const group of settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "hooks"),
      false,
      `group ${group.id} must not contain hooks`,
    );
  }
  // A section that lost its entry without losing its id would render an empty page.
  assert.ok(settingsSections.length > 0, "the sidebar must still have sections");
});

test("a hooks section intent or stored preference degrades to the fallback", () => {
  assert.equal(isSettingsSectionEnabled("hooks"), false);
  assert.equal(resolveSettingsSection("hooks"), "general");
  assert.equal(resolveSettingsSection("hooks", "modelProvider"), "modelProvider");
  assert.equal(
    resolveSettingsSectionForPlatform("hooks", createSettingsPageConfig().settingsSections),
    "general",
  );
  // Unrelated sections keep their behavior.
  assert.equal(resolveSettingsSection("modelProvider"), "modelProvider");
  assert.equal(isSettingsSectionEnabled("modelProvider"), true);
});
