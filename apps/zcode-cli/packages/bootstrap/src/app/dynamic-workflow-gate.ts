import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./bundled-skills.js";

/**
 * The app wiring layer filters the companion skills by the dynamic workflow switch.
 * The subtraction on the tool surface lives in core's registerBuiltInTools; the subtraction for the `/` directory and for `/workflow` expansion lives in
 * zcode-protocol/slash-commands.ts and builtin-prompt-command.ts respectively; only the skill exclusions that need path derivation on the bootstrap side belong here.
 */

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * Absolute SKILL.md paths to exclude from skill discovery when the dynamic workflow switch is off.
 *
 * Why filter by path rather than by root: NodeSkillAdapter offers only one exclusion mechanism, `disabledPaths`
 * (config.json's `skill.<path>.enable=false` goes through it too). What is passed in is the root of the built-in skill bundle
 * (bundled-skills.ts); when the path does not exist it is merely a Set member that never matches, with no side effects; when the skill bundle later holds
 * skills unrelated to the dynamic workflow switch, they will not be collaterally excluded either.
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
): string[] {
  return bundledSkillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
