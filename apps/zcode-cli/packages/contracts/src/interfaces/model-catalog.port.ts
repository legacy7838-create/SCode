// ============================================================
// Model Catalog Port - A read-only snapshot boundary that hosts a configured model
// ============================================================
// There is only one reason for existence:
// The tool layer needs to parse the model name ("GLM-5.3-Flash") mentioned by the user into a sub-agent selection for a workflow run, and the core
// The provider registry is not visible. The port passes in the host fact "what models are there", and the parsing itself remains in the core
// (Pure function, no I/O).
//
// Deliberate **synchronous, no I/O**: the call points are in the handlers of `resolveInput` and `ListModels`, and should not be placed in either place
// In order to make a list and wait for the network; the host side just reads a registry view in memory.

/** One model entry in the catalog (a single provider × model combination). */
export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  /** The human-readable name of the provider; absent when the registry does not give one (the read side falls back to `providerId`). */
  providerLabel?: string;
  /** The reasoning levels this model supports (the legal values of `$level`). A model with no levels is an **empty array**, not an absent value. */
  reasoningLevels: string[];
  /** The registry's default level; absent when `reasoningLevels` is empty. */
  defaultReasoningLevel?: string;
  contextWindow?: number;
  /** Whether this entry is exactly the session's current selection (same provider + model). At most one entry in the whole table is true. */
  current: boolean;
  /** The reason it cannot be selected (no key configured, disabled by policy, etc.); absent when it can be selected. */
  disabledReason?: string;
}

export interface ModelCatalogPort {
  /**
   * Lists the models that are selectable right now.
   *
   * **Every call must read the registry's live view afresh** and must never return a copy frozen at construction time: providers can be added, removed, or changed mid-session (the lesson of the stale provider registry was a subagent
   * holding on to the adapter copy built when the parent session was constructed). A stale catalog would let resolution pick a model that no longer exists, and the failure would only blow up when the subagent
   * first speaks — a long way from the user pressing confirm.
   */
  listModels(): ModelCatalogEntry[];
}
