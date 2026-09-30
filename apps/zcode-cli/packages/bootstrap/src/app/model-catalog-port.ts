// ============================================================
// Host implementation of ModelCatalogPort: Provider Registry → model directory visible to the tool layer
// ============================================================
// For port contracts, see contracts/src/interfaces/model-catalog.port.ts. There is only one reason for existence:
// `subagent_model` of `CreateWorkflow` / `AmendWorkflow` needs to parse the model name mentioned by the user once
// Subagent selection for workflow run, while core cannot see the provider registry. This module hosts the "what models are there"
// The facts are passed over, and the parsing itself remains in the pure function of core.
//
// `listRegistryBackedModels` of provider-registry-selection.ts are the two faces of the same registry:
// The GUI picker's `ZCodeModelOption` (with label / maxOutputTokens / format attributes) is output there, and the output is here
// Narrow items for tool level. Deliberately not sharing the same projection function - the field sets and presence rules of the two faces are independent, forcing them to merge will only
// Let a change to the picker quietly change the criteria for model parsing. What is shared is the **default gear rule** (see below).

import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

interface ModelCatalogPortDeps {
  /** The process's Provider Registry. The **whole object** is kept; it must never be snapshotted here with a single `getView()` call. */
  registry: ProviderRegistryModelSource;
  /**
   * The session's **current** model selection (`runtime.getSessionModelSelection()`). Like the registry it is a function and
   * not a value: `current` is the fact as of the moment of each listing, and the user can switch the primary model between two tool calls.
   */
  currentSelection: () => ModelSelection | undefined;
}

/**
 * Builds a {@link ModelCatalogPort}.
 *
 * **`listModels()` reads `registry.getView()` fresh on every call**, never caching it -- this is not a performance trade-off but a
 * direct lesson learned from a stale provider registry: a subagent holds on to the provider adapter from the moment the parent session was constructed and, after the
 * user changes the provider midway, the subagent keeps sending requests against a configuration that no longer exists. A catalog frozen at construction time lets
 * `subagent_model` resolution pick a model that has by then been deleted, and the failure only blows up when the subagent first speaks -- by which point the user
 * pressed confirm a long time ago. The view itself is an in-memory object, so re-reading it is not I/O.
 */
export function createModelCatalogPort(deps: ModelCatalogPortDeps): ModelCatalogPort {
  return {
    listModels(): ModelCatalogEntry[] {
      // This line is the full realization of the above discipline. Any "optimization" that takes it outside of closures is reproducing the same problem.
      const view = deps.registry.getView();
      const current = deps.currentSelection();
      return view.providers.flatMap((provider) =>
        provider.models.map((model): ModelCatalogEntry => {
          const reasoning = model.config.optionSpecs.reasoningLevel;
          // The gear table is copied instead of passed out as-is: the registry values are part of the readonly view,
          // The port contract gives a common readable array, allowing the caller to get a copy that will not change with the registry.
          const reasoningLevels = [...reasoning.values];
          // Default gear = last gear, same as `toModelOption` of provider-registry-selection.ts
          // (GUI picker's `reasoning.defaultLevel`) **Same rule**. Different defaults are given in two places,
          // There will be a "default high in picker, `subagent_model` defaults to low when no gear is written." This kind of problem is only available to users.
          // deviations will be found. Models without gears have the entire field absent (empty array + no default).
          const defaultReasoningLevel = reasoning.values.at(-1);
          const contextWindow = model.config.properties.contextWindow;
          // `providerName` in the registry is `string | null | undefined` (config-service.ts replaces the empty string
          // normalized to `null`), while the port contract is `string | undefined`. Three kinds of "unnamed" are synthesized here
          // **A** answer: The key is absent. Never pass a `null` or empty string - it will be printed into ListModels unchanged
          // That line, what the reader wants is "Return providerId without taking the name".
          const providerLabel = provider.providerName?.trim();
          return {
            providerId: provider.providerId,
            modelId: model.modelId,
            // The human readable name of the provider; it will be absent if it is not retrieved (the providerId will be returned on the reading side), so it is not covered here.
            // providerId - that will make the "has it been named" thing disappear on the port.
            ...(providerLabel ? { providerLabel } : {}),
            reasoningLevels,
            ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            // The two parts of the identity are equal and are the current selection; options are not part of the identity (similar to workflow-actor-model.ts
            // The pins are compared to the same criterion). At most one item in the entire table is true.
            current:
              current !== undefined &&
              current.providerId === provider.providerId &&
              current.modelId === model.modelId,
            // `disabledReason` Deliberate **constant absence**: This host has no source of this fact today. Model list for GUI
            // Take the same registry (listRegistryBackedModels → toModelOption), and never write this on that path
            // Fields; `registry.validateSelection()` is also not a source - every item we enumerate comes from the registry
            // The view itself must pass the verification according to the construction. The only place in the warehouse that produces disabledReason is
            // In the desktop legacy configuration migration of packages/services, this registry is not accessible. There really is a future
            // The criteria for "configured but unavailable" (missing key, disabled by policy) can be filled here, and the port contract does not need to be touched.
          };
        }),
      );
    },
  };
}
