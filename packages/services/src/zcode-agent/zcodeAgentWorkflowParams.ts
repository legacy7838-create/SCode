import type { ZCodeSavedWorkflowMeta, ZCodeSavedWorkflowScope } from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgentPluginParams.js";

// GUI hub for saved workflows: five workspace-level, session-less methods.
// The same path as the Skill catalog (workspace agent client), without going through the independent plug-in management process - the file is in
// In the workspace, when using the remote workspace, scan the remote directory in the remote agent process.
//
// Global workflow: `scope: "global"` when the file falls on the agent machine
// `~/.zcode/workflows/`. The caller can omit the workspace - in this case the services layer chooses the **carrier runtime**
// (Active local runtime → management plane workspace), the protocol processor does not read the workspace path for global files.
// Actions within the project group still have their own workspace (both a running target and a carrier), so a union is used below:
// Either bring workspace (scope is optional, default is project), or only `scope: "global"` (workspace is optional).
export type ZCodeAgentSavedWorkflowTarget =
  | (ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope })
  | ({ scope: "global" } & Partial<ZCodeAgentWorkspaceTarget>);

export type ZCodeAgentListSavedWorkflowsParams = ZCodeAgentSavedWorkflowTarget;

export type ZCodeAgentGetSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentUpdateSavedWorkflowMetaParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
  meta: ZCodeSavedWorkflowMeta;
};

export type ZCodeAgentDeleteSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentListSavedWorkflowRunsParams = ZCodeAgentSavedWorkflowTarget & {
  /** Just run under this workflow name; the default is all (under this scope). */
  name?: string;
  /** [1, 50]; Server-side clamping. */
  limit: number;
};

// workflows/move: Move the global file back to the project file,
// **This is the only way**. `workspace`
// Required, it is both the carrier and the target project selected by "Move to Project..."; the same machine and user will not overwrite the existing target.
export type ZCodeAgentMoveSavedWorkflowParams = ZCodeAgentWorkspaceTarget & {
  name: string;
};
