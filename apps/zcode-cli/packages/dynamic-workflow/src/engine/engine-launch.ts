// ============================================================
// run-launched: The host metadata of the run round → event
// ============================================================
// The engine does not read these metadata (anchors, stage tables, parallel tables, sub-agent selection), and only builds and runs the first item in that life.
// `run-started` is transcribed verbatim once (engine.ts). The structure is separated into modules, and engine.ts and types.ts are left in
// Within the lint limit of 400 lines - they are files that grow on both sides.

import type { RunEvent } from "./types.js";

/**
 * The host metadata that rides along with `run-launched` in the turn that launches a run (EngineConfig.launch): the anchor `inputId`,
 * the script-declared phase table `phaseNames`, the positionally aligned `phaseAlongside`, the selection for this run's
 * subagent `subagentModel`, and which file the script came from `scriptPath`. The engine reads none of the five -- see the comment on
 * `run-launched` in types.ts for the field semantics.
 */
export interface RunLaunchConfig {
  inputId: string;
  phaseNames?: string[];
  subagentModel?: string;
  /** The absolute path of this run's script file. */
  scriptPath?: string;
  phaseAlongside?: number[][];
}

/**
 * Transcribes the launch metadata into `run-launched`. Keys that are not set are **absent** rather than landing as an undefined value: the reading
 * side (the three states of AmendWorkflow, the projection) treats "not set" and "set to empty" as two different things.
 */
export function runLaunchedEvent(
  launch: RunLaunchConfig,
  origin: { toolCallId?: string | undefined; parentSessionId?: string | undefined },
): RunEvent {
  const { inputId, phaseNames, subagentModel, scriptPath, phaseAlongside } = launch;
  return {
    type: "run-launched",
    inputId,
    ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    ...(origin.parentSessionId === undefined ? {} : { parentSessionId: origin.parentSessionId }),
    ...(phaseNames === undefined ? {} : { phaseNames }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
  };
}
