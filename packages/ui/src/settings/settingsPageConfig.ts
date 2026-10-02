import {
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  AlarmClock,
  Brain,
  Cable,
  WandSparkles,
  Keyboard,
  FileSearch,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

type SettingsSectionGroupId = "basics" | "agentCapabilities" | "dataAndStats";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  // Keyboard shortcuts are stored at the end of the basic settings.
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
  },
  // Workspace search scope (.zcodeignore): basic workspace behavior configuration for all users, collected at the end of the basic settings.
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
  },
];

// Compatible with existing read-only consumers: the default configuration is the same visible
// section list that createSettingsPageConfig derives.
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter((section) =>
  isSettingsSectionEnabled(section.id),
);

export function createSettingsPageConfig() {
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) =>
    isSettingsSectionEnabled(section.id),
  );
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export type { SettingsSectionId };
