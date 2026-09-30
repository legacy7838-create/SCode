// ZCode Protocol v4 - Data model draft.
//
// Discipline of this package: only put schema type + pure function
// (coalesce/conflation/apply), runtime (channel layer buffering, subscription registry, scheduling) will not be included in this package.
// Coexists with the old packages/shared/src/zcode-protocol.
export * from "./core.js";
export * from "../background-bash-output.js";
export * from "./rows.js";
export * from "./toolDisplay.js";
export * from "./create-workflow-display.js";
export * from "./workflow-observation-display.js";
export * from "./snapshot.js";
export * from "./workflow-runs.js";
export * from "./workflow-runs-reducer.js";
// Key-level increment of workflowRuns (diff/apply/canonical key order); op itself in delta.js.
export * from "./workflow-runs-delta.js";
// The traces left by the world: rejected instance counts, item budgets, step readings; vacating when the table is full; and tailoring to old consumers.
export * from "./workflow-runs-caps.js";
export * from "./workflow-runs-eviction.js";
export * from "./workflow-runs-tables.js";
export * from "./workflow-runs-legacy.js";
export * from "./workflow-artifact.js";
// ⚠ There is only one s difference from the previous line, and the two artifacts are not synonymous: singular = the "script top-level return value" inside the engine
// Serialization; plural = the output of a script `artifact.*` that is published to the user. See the header of workflow-artifacts.ts.
export * from "./workflow-artifacts.js";
// Workspace transcript (replay of files.*/git.*/world.run).
export * from "./workflow-workspace.js";
export * from "./attachment-ref.js";
export * from "./attachment-faults.js";
export * from "./delta.js";
export * from "./coalesce.js";
export * from "./profiles.js";
export * from "./apply.js";
export * from "./transport.js";
export * from "./wire.js";
export * from "./wire-codec.js";
export * from "./wire-reassembly.js";
export * from "./wire-assembler.js";
export * from "./wire-fault.js";
export * from "./sessions-index.js";
export * from "./sessions-index-workflow-activity.js";
export * from "./workspace-config.js";
export * from "./command.js";
export * from "./workflow-run-settings-command.js";
export * from "./shared-context-ref.js";
export * from "./shared-context-import.js";
export * from "./input-intent.js";
export * from "./submission.js";
export * from "./fork.js";
export * from "./telemetry.js";
export * from "./controller.js";
export * from "./workspace-hook-review.js";
export * from "./cuaPermission.js";

export {
  executionOutputPreviewSchema,
  type ExecutionOutputPreview,
} from "../execution-output-preview.js";

export { bashOutputDisplaySchema } from "../bash-output-display.js";
export { modelSelectionSchema, type ModelSelection } from "../model-selection.js";

export * from "../localTtft.js";
