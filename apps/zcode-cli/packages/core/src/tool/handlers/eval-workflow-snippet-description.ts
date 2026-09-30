// The resident description of EvalWorkflowSnippet.
//
// The scope and writing rules of the snippet facade are in the "Tool" of the `dynamic-workflows` skill
// Reference", the skill gate ensures that it has been read; here we only talk about what it is, what it is used for, and read the skills first.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox and world-read execution path a real run uses. It is the test bench for workflow authoring: check a parser against real command output, see what a glob actually returns, or exercise a gate predicate on real repository state before putting it in a CreateWorkflow script. No agent()/report(); nothing persists; the result comes back in this call.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool first: it carries the snippet facade and the rules. The call is refused until that skill has been loaded in this session. Pass \`code\` (inline) or \`path\` (a file holding the snippet), never both.`,
].join("\n");
