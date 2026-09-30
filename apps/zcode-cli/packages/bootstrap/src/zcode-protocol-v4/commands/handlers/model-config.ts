// Model configuration command group: switchModelConfig (transported from the old server-operations.switchModelConfig semantics)
// + switchCollaborationMode(additive, UI mode selector)
// + applyRequestedSessionConfig (createSession.config consumer utility).
// One file per command group: handler pure function (host, envelope) → CommandResult|undefined,
// The decision-making logic directly drives the core (app.setModel / app.setMode / runtime.emit*) without going through the old protocol op.
import type { CollaborationMode, ModelSelection } from "@zcode/contracts";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { runSessionModelConfigMutation } from "../../model-config-mutation.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/** The noop reasonCode for a switch to the same value. */
const CONFIG_UNCHANGED = "config.unchanged";

/**
 * The target Provider is not in the current Environment Registry. The Gateway maps it to a failed
 * ACK; the caller needs to refresh the current Environment's Provider Config rather than re-push a
 * Host Snapshot to the Worker.
 */
class V4ProviderNotInRegistryError extends Error {
  readonly reasonCode = "provider.notInRegistry";
  constructor(providerId: string) {
    super(`provider "${providerId}" is not in the workspace model registry`);
  }
}

/**
 * Before switching models, confirm the target Provider already exists in the current Environment
 * Registry. `applied:false` is converted into a structured domain error (gateway -> failed ACK).
 * When the Host injects no capability, the old Entry behaviour is kept.
 */
async function ensureProviderClientReady(
  host: V4CommandCoreHost,
  sessionId: string,
  providerId: string,
): Promise<void> {
  if (!host.ensureProviderAvailable) return;
  const outcome = await host.ensureProviderAvailable(sessionId, providerId);
  if (!outcome.available && outcome.reason === "provider_not_in_registry") {
    throw new V4ProviderNotInRegistryError(providerId);
  }
  // session_not_found and other reasons: requireRecord has been verified on the handler side first, and the theory is not up to date;
  // Don’t throw away the whole thing (let subsequent setModel take the existing path/report an error) to avoid swallowing the real positioning.
}

function createModelSelection(provider: string, model: string, thought: string | undefined) {
  return {
    providerId: provider,
    modelId: model,
    ...(thought ? { options: { reasoningLevel: thought } } : {}),
  };
}

function readActualThought(
  record: V4SessionRecordView,
  fallbackSelection?: ModelSelection,
): string {
  const thought = record.app.getThoughtLevel();
  if (thought !== undefined) return thought;
  return fallbackSelection?.options?.reasoningLevel ?? "";
}

/** The value domain of the switchCollaborationMode command (same source as the z.enum in command.ts; `auto` is not user-switchable and is not included). */
const SWITCHABLE_MODES: ReadonlySet<string> = new Set(["build", "edit", "plan", "yolo"]);

/**
 * switchModelConfig: switches the session's model selection. Across models, app.setModel swaps the
 * provider client + model; for the same model, `thought` is the explicit thinking-depth switch, and
 * ModelSelected is emitted afterwards - both the v4 projection's config area update and the
 * modelChange marker for a mid-run switch depend on that event (reducer onModelSelected).
 *
 * Behavioural equivalence note: the old protocol path has no active-turn guard (switching is
 * allowed while running); this path stays consistent and adds none.
 */
async function switchModelConfig(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
  const record = requireRecord(host, envelope.sessionId);
  return runSessionModelConfigMutation(record.app, async () => {
    // previous must be snapshotted within the serialization critical section and before setModel. registry fallback may be ranked before this command
    // Previously, reading before queuing would get the expired previous and split the noop/event order from the runtime truth value.
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const modelIdentityChanged =
      previousSelection?.providerId !== payload.provider ||
      previousSelection?.modelId !== payload.model;
    const requestedThought = payload.thought.trim();
    const thoughtChanged =
      Boolean(requestedThought) && requestedThought !== previousSelection?.options?.reasoningLevel;
    // Same value switching closure: hit runtime current value → noop ACK (config.unchanged),
    // It cannot be swallowed silently with accepted - after the seeds are aligned, "UI display value = runtime true value" is established.
    // The client distinguishes between "effective" and "originally this value" based on this.
    if (!modelIdentityChanged && !thoughtChanged) {
      throw new V4CommandNoopError(CONFIG_UNCHANGED);
    }
    // Before setModel, the current Environment Registry confirms that the target Provider is available.
    await ensureProviderClientReady(host, record.app.sessionId, payload.provider);
    let actualThought = previousThought;
    let nextModelSelection: ModelSelection;
    if (modelIdentityChanged) {
      const result = await record.app.setModel(`${payload.provider}/${payload.model}`);
      actualThought = result.thoughtLevel ?? readActualThought(record);
      if (requestedThought && record.app.listThoughtLevels().includes(requestedThought)) {
        // This is a pin even if the user explicitly selects the same gear as the default. The setter must be called to let
        // Session Selection saves this explicit leaf and cannot swallow the intent because the effective value is the same.
        const thoughtResult = await record.app.setThoughtLevel(requestedThought);
        actualThought = thoughtResult.thoughtLevel;
      }
      nextModelSelection = createModelSelection(
        payload.provider,
        payload.model,
        requestedThought && record.app.listThoughtLevels().includes(requestedThought)
          ? requestedThought
          : undefined,
      );
    } else {
      // The same provider/model indicates explicit user change; illegal values ​​fail before any model changes.
      const result = await record.app.setThoughtLevel(requestedThought);
      actualThought = result.thoughtLevel;
      nextModelSelection = createModelSelection(payload.provider, payload.model, actualThought);
    }
    await record.app.runtime.emitModelSelected({
      modelSelection: nextModelSelection,
      ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
      previousModelSelection,
      supportedThoughtLevels: record.app.listThoughtLevels(),
      // The trace link structure is transparently transmitted from the record (session root trace) and is not associated with the traceId if it is not created at the command layer.
      traceContext: record.traceContext,
    });
    return undefined;
  });
}

/**
 * switchCollaborationMode: switches the agent's collaboration mode (plan/build/edit/yolo).
 * app.setMode updates the autonomous-execution state, persists it and publishes SessionModeChanged
 * in one place; the command layer no longer emits a second event, and the v4 projection reducer
 * onSessionModeChanged updates config.mode from it.
 * A switch to the same value -> noop ACK: a silent `return undefined` is taken as accepted, and if
 * the projection seed is missing that stacks into the user-visible "clicked full access, nothing
 * happened" problem - the CLI already thinks it is yolo and returns early, while the projection is
 * still stuck at the seed build, with no way for the client to tell. Hence the explicit ACK.
 */
async function switchCollaborationMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["switchCollaborationMode"];
  const record = requireRecord(host, envelope.sessionId);
  const mode = payload.mode as CollaborationMode;
  const previousMode = record.app.getMode();
  if (previousMode === mode && !record.app.runtime.getPlanEnabled()) {
    throw new V4CommandNoopError(CONFIG_UNCHANGED);
  }
  await record.app.setMode(mode);
  return undefined;
}

/**
 * The shared createSession.config consumer ("createSession.config must be consumed"): it folds
 * the request config over the runtime defaults, takes effect only on the parts that differ from
 * the runtime's current values, and emits the same events as the switch commands (ModelSelected /
 * SessionModeChanged) - the log is self-contained, the projection closes through the existing
 * reducer, and no second write path is needed.
 *
 * Why events rather than editing the seed directly: the publisher already exists by the time the
 * createSessionRecord event wiring runs, and the seed reads the runtime defaults as they were
 * before the request config was applied; emitting the events both corrects the projection and puts
 * the fact "which model did it start with" into the log (reproducible on cold-recovery replay).
 * When prev is empty on a first selection the reducer produces no modelChange marker
 * (onModelSelected: "a first selection is not a switch"), so there is no noise line.
 *
 * Partial-failure semantics: the session was created successfully, and a failure applying the
 * config must not take createSession down with it (leaking a record in exchange for a failed ACK
 * is not worth it) - the caller catches it and downgrades to a warn, and the session keeps the
 * runtime defaults.
 */
export async function applyRequestedSessionConfig(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  config: NonNullable<CommandPayloadMap["createSession"]["config"]>,
): Promise<void> {
  await runSessionModelConfigMutation(record.app, async () => {
    const previousSelection = record.app.runtime.getSessionModelSelection();
    const previousModelSelection =
      previousSelection &&
      createModelSelection(
        previousSelection.providerId,
        previousSelection.modelId,
        previousSelection.options?.reasoningLevel,
      );
    const previousThought = readActualThought(record, previousSelection);
    const requestedSelection = config.modelSelection;
    const targetProvider =
      requestedSelection?.providerId ?? config.provider?.trim() ?? previousSelection?.providerId;
    const targetModel =
      requestedSelection?.modelId ?? config.model?.trim() ?? previousSelection?.modelId;
    const targetThought =
      requestedSelection?.options?.reasoningLevel ?? config.thought?.trim() ?? "";
    const modelIdentityChanged =
      targetProvider !== previousSelection?.providerId ||
      targetModel !== previousSelection?.modelId;
    const thoughtChanged =
      Boolean(targetThought) &&
      targetThought !==
        (requestedSelection ? previousSelection?.options?.reasoningLevel : previousThought);
    if (targetProvider && targetModel && (modelIdentityChanged || thoughtChanged)) {
      // When the first Provider is not in the Registry, provider.notInRegistry is thrown, and the capture at createSession is downgraded to
      // warn (the session keeps the runtime default and is not created continuously), the semantics are consistent with the existing config application failure.
      await ensureProviderClientReady(host, record.app.sessionId, targetProvider);
      let actualThought = previousThought;
      if (modelIdentityChanged) {
        const result = await record.app.setModel(`${targetProvider}/${targetModel}`);
        actualThought = result.thoughtLevel ?? readActualThought(record);
      }
      if (targetThought && record.app.listThoughtLevels().includes(targetThought)) {
        const result = await record.app.setThoughtLevel(targetThought);
        actualThought = result.thoughtLevel;
      } else if (requestedSelection?.options?.reasoningLevel) {
        // Explicit options for formally structured Selection must fail-closed; only old flat config
        // Maintain the published compatibility behavior of "use default if not supported by target".
        await record.app.setThoughtLevel(targetThought);
      }
      if (modelIdentityChanged || actualThought !== previousThought) {
        // The draft warmup config may carry thoughts from the previous model. Reserved if the target model does not support it
        // The compatible gear that has been parsed by setModel still publishes target model events to avoid creating a runtime/projection split session.
        await record.app.runtime.emitModelSelected({
          modelSelection: createModelSelection(
            targetProvider,
            targetModel,
            targetThought && record.app.listThoughtLevels().includes(targetThought)
              ? targetThought
              : undefined,
          ),
          ...(actualThought ? { effectiveReasoningLevel: actualThought } : {}),
          previousModelSelection,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          traceContext: record.traceContext,
        });
      }
    }
  });

  // mode: payload.config.mode is a wide string (schema default compatible), and the value range ends here.
  const mode = config.mode;
  if ((mode && SWITCHABLE_MODES.has(mode)) || config.planEnabled !== undefined) {
    await record.app.runtime.setExecutionState(
      {
        ...(mode && SWITCHABLE_MODES.has(mode) ? { mode } : {}),
        ...(config.planEnabled !== undefined ? { planEnabled: config.planEnabled } : {}),
      },
      record.traceContext,
    );
  }

  // followupMode: The runtime default is queue (the initial value of the projection is the same), only the non-default value needs to be written explicitly——
  // runtime.setFollowupMode has no identical value guard (unconditional append event), and explicitly passing "queue" will cause idle delta.
  if (config.followupMode && config.followupMode !== "queue") {
    await record.app.setFollowupMode(config.followupMode);
  }
}

export const modelConfigHandlers = { switchModelConfig, switchCollaborationMode };
