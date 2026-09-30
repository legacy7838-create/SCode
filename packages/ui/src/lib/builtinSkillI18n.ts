import type { Locale, SkillScope } from "@zcode/shared";

interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

const BUILTIN_SKILL_DESCRIPTIONS: Record<string, string> = {
  "android-dev":
    "Build, run, inspect, and lightly automate Android apps through the android-emulator MCP tools.",
  brainstorming:
    "Use before any creative work, including creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.",
  "control-browser":
    "Control ZCode's built-in browser to open, inspect, click, type, screenshot, or verify webpages and local development targets.",
  "dispatching-parallel-agents":
    "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
  docx: "Create, edit, and analyze DOCX documents with revisions, comments, formatting preservation, and text extraction. Use for new documents, edits, revision handling, comments, and professional Word document work.",
  "executing-plans":
    "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
  "finishing-a-development-branch":
    "Use when implementation is complete, tests pass, and you need to decide how to integrate the work through merge, PR, or cleanup.",
  "ios-dev":
    "Build, run, inspect, and lightly automate iOS Simulator apps through the ios-simulator MCP tools.",
  pdf: "Professional PDF toolkit for reports, creative visuals, academic LaTeX, and existing-PDF workflows. Supports reports, posters, papers, resumes, extraction, merge, split, forms, and conversion.",
  pptx: "Inspect and narrowly update elements selected in PPTX Preview Pane. Verifies the whole-file fingerprint and OOXML locator for shape or table-cell text, and stops on conflicts instead of guessing.",
  "receiving-code-review":
    "Use when receiving code review feedback before implementing suggestions, especially when feedback is unclear or technically questionable.",
  "requesting-code-review":
    "Use when completing tasks, implementing major features, or before merging to verify work meets requirements.",
  "plugin-creator": "Create and validate ZCode plugins, and guide local installation and updates.",
  "skill-creator":
    "Create new skills, edit existing skills, and iterate wording. Use for writing SKILL.md from scratch, improving skills, capturing repeated workflows, or tuning descriptions for reliable triggering.",
  "subagent-driven-development":
    "Use when executing implementation plans with independent tasks in the current session.",
  "systematic-debugging":
    "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
  "test-driven-development":
    "Use when implementing any feature or bugfix, before writing implementation code.",
  "using-git-worktrees":
    "Use when starting feature work that needs isolation or before executing implementation plans. Ensures an isolated workspace exists via native tools or git worktree fallback.",
  "using-superpowers":
    "Use when starting any conversation. Establishes how to find and use skills, requiring Skill tool invocation before any response including clarifying questions.",
  "verification-before-completion":
    "Use before claiming work is complete, fixed, or passing. Requires running verification commands and confirming output before success claims.",
  "web-gui-tester":
    "Run pure GUI black-box tests against websites and local web frontends with ZCode Browser Use, combining real user interactions, semantic DOM evidence, and inspected screenshots.",
  "writing-plans":
    "Use when you have a spec or requirements for a multi-step task, before touching code.",
  "writing-skills":
    "Use when creating new skills, editing existing skills, or verifying skills work before deployment.",
};

export function resolveSkillSourceLabel(scope: SkillScope, _locale?: Locale): string {
  if (scope === "workspace") return "Workspace";
  if (scope === "plugin") return "Plugin";
  return "User";
}

export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
  _locale?: Locale,
): string {
  const localized = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]
    : undefined;
  return localized ?? skill.description;
}

function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
