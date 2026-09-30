/**
 * `@zcode/dynamic-workflow-runtime`: the sandbox harness.
 *
 * It exposes the harness entry point, the wire protocol types, the rendering and writing of entry
 * files (`renderChildEntry` / `writeChildEntryFile`, which tests and tools use to produce entry
 * files shaped exactly like production ones), and the child process exit `childMain`. The SEA hidden
 * subcommand (`__zcode-dwf-child`) no longer imports this package: the entry file carries childMain
 * itself, and the subcommand only `import()`s the file and calls its `start`.
 */

export {
  runWorkflowScript,
  type DriverFactory,
  type RunControlBinding,
  type RunWorkflowOptions,
} from "./harness.js";
export {
  childMain,
  renderChildEntry,
  type ChildMainDeps,
  type ChildReadlineInterface,
  type ChildVmModule,
} from "./child-source.js";
export {
  childEntryFileName,
  fallbackWorkflowRunsDir,
  workflowRunsDir,
  writeChildEntryFile,
  type ChildEntryFile,
  type HarnessWarning,
  type WriteChildEntryFileInput,
} from "./child-entry-file.js";
export {
  type ChildMessage,
  type ChildPayload,
  type CompleteMessage,
  type CreateActorMessage,
  type EventMessage,
  type ParentMessage,
  type RequestMessage,
  type ResponseMessage,
  type WireError,
} from "./protocol.js";
