import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";

/**
 * The Computer Use page was removed from the Settings surface while its section id stays valid only
 * for migration (docs/specs/settings-section-computer-use-removal.md), so a stored preference or the
 * composer entry's intent degrades to the fallback instead of rendering an unreachable page.
 */

test("the Computer Use section is not part of the settings sidebar", () => {
  const { settingsSections, settingsSectionGroups } = createSettingsPageConfig();
  assert.equal(
    settingsSections.some((section) => section.id === "computerUse"),
    false,
    "the sidebar entry list must not contain computerUse",
  );
  for (const group of settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "computerUse"),
      false,
      `group ${group.id} must not contain computerUse`,
    );
  }
  assert.ok(settingsSections.length > 0, "the sidebar must still have sections");
});

test("the config factory needs no desktop gating arguments anymore", () => {
  // The desktop options existed only to join the Computer Use section at runtime.
  assert.equal(createSettingsPageConfig.length, 0, "createSettingsPageConfig takes no arguments");
});

test("a computerUse section intent or stored preference degrades to the fallback", () => {
  assert.equal(isSettingsSectionEnabled("computerUse"), false);
  assert.equal(resolveSettingsSection("computerUse"), "general");
  assert.equal(resolveSettingsSection("computerUse", "modelProvider"), "modelProvider");
  assert.equal(
    resolveSettingsSectionForPlatform("computerUse", createSettingsPageConfig().settingsSections),
    "general",
  );
  // Unrelated sections keep their behavior.
  assert.equal(resolveSettingsSection("general"), "general");
  assert.equal(isSettingsSectionEnabled("general"), true);
});
