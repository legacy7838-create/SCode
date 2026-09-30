// The resident description of AmendWorkflow.
//
// How to hit the cache, the three fields that will be used if omitted, the two sources of `path` and `script`, and the confirmation window
// Whenever it appears, it is in the "Tool reference" of the `dynamic-workflows` skill, and is guaranteed to be read by the skill gate. Only stay here
// Routing - when should you revise rather than rebuild, don't stop first, don't wait - because it determines "whether to adjust this tool or not",
// Must be read before the skill is loaded.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const AMEND_WORKFLOW_TOOL_DESCRIPTION = [
  "Amend an existing dynamic-workflow run with a revised script or revised settings. Starts a NEW run that supersedes the old one and imports its finished work as a cache, so only what you changed is paid for again. Works on ANY run of this project: completed, errored, stopped — or still running.",
  "",
  "When to use:",
  "- The run errored, or completed but needs one more stage: fix or extend the script and amend. Never rewrite the workflow from scratch with CreateWorkflow.",
  "- The run is STILL RUNNING and is visibly going wrong: amend it NOW, in one call. Do not TaskStop it first and do not wait for it to finish — this tool stops the running predecessor and starts the revision; the earlier you amend, the less is re-paid.",
  "- The user wants the same workflow with fewer subagents at once, its subagents on another model, or another name: amend with only that field and neither `path` nor `script`.",
  "- To continue a stopped run unchanged, use ResumeWorkflowRun instead.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool before revising a script: it carries the cache rules, what each omitted field keeps, and the confirmation rule. A call that passes \`path\` or \`script\` is refused until that skill has been loaded in this session; a settings-only call is not. Pass \`path\` (the run's script file, edited in place — the usual form) or \`script\` (the whole revised script inline), never both.`,
].join("\n");
