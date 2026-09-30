// The resident description of the SaveWorkflow.
//
// The file format, parameter declaration and writing rules are all in the "Tool" of the `dynamic-workflows` skill.
// Reference", which is guaranteed to be read by the skill gate. What remains here is the only one that you must see before you decide whether to adjust or not.
// Rule - never actively save. Saving will leave files in the user's repository, and the model's judgment of "looks pretty general" is much better than the user's
// Loose; this threshold must be permanent and cannot wait until the skill is loaded.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  "Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow's `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.",
  "",
  "NEVER call this tool unsolicited: saving writes a file into the user's repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass \`script\` (the body only) or \`script_path\` (a draft file, saved without re-emitting it), never both.`,
].join("\n");
