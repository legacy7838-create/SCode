// ============================================================
// Parsing of model references (string of `subagent_model` → one-time selection)
// ============================================================
//
// Pure functions, zero I/O: Host facts are passed in via `ModelCatalogPort` (contracts’
// `interfaces/model-catalog.port.ts`), the parsing itself remains in core. The reason for separation is **measurable**——
// Three-level matching, uppercase and lowercase, gear check and "What to say when you can't figure it out" are the only areas in this set that will be repeatedly changed.
// Once they are mixed with the port implementation, they can only be fixed by integration testing.
//
// There is only one call point: `resolveInput` of `CreateWorkflow` / `AmendWorkflow`. Parsing must occur in
// Confirm window **before** - the window displays the model that will take effect, and the window should not be opened at all for calls that cannot be solved.

import type { ModelCatalogEntry, ModelSelection } from "@zcode/contracts";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  formatModelPickerValue,
  parseModelPickerValue,
} from "@zcode/shared/model-selection";

/**
 * The resolution result. Failures always carry `candidates`: after a model guesses a name wrong,
 * the most useful next piece of information is "what is here", otherwise it will just guess the
 * same name differently once more.
 */
type ModelReferenceResolution =
  | { ok: true; selection: ModelSelection; entry: ModelCatalogEntry; canonical: string }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "disabled" | "reasoning_level_unknown";
      message: string;
      candidates: ModelCatalogEntry[];
    };

/**
 * The row cap on the `not_found` list. A catalog configured with dozens of providers can list
 * hundreds of rows, and this copy goes straight into the model's context - so the overflow is
 * replaced with the sentence "call ListModels for the rest", which is the route that **can** get
 * everything, whereas truncation is not.
 */
const MODEL_REFERENCE_CANDIDATE_LINES = 40;

/**
 * Resolves the model name the user said into one selection. Three tiers, from most to least
 * specific (the order is part of the spec):
 *
 *   1. an exact hit on the full `providerId/modelId`;
 *   2. a bare `modelId` that hangs off exactly one provider;
 *   3. a bare `modelId` hanging off several providers -> take the one that is the **current
 *     session's** if there is one, otherwise `ambiguous`.
 *
 * All comparisons are case-insensitive: the registry offers no display name different from
 * `modelId`, so there is no "look again by label" tier - between the name the user said and the
 * id, only case and the provider prefix differ.
 *
 * A disabled entry is **never** a silent hit: when only disabled entries match, answer `disabled`
 * with each one's reason. Skipping it quietly to pick a different model hands the user a model they
 * did not ask for; picking it quietly only blows up when the subagent first speaks.
 *
 * When `$level` is present it must be a legal tier of that model (otherwise
 * `reasoning_level_unknown`); when absent, take the registry's default tier (a model with no tiers
 * carries no options). `canonical` is in picker form, spelled the way the registry spells it -
 * and that is the form used from there on, by the journal's `run-launched` event, by both read
 * surfaces and by the confirmation window.
 */
export function resolveModelReference(
  text: string,
  entries: ModelCatalogEntry[],
): ModelReferenceResolution {
  const { reference, level } = splitReasoningLevel(text.trim());
  const matches = matchEntries(reference, entries);
  if (matches.length === 0) return notFoundResolution(text, entries);

  const enabled = matches.filter((entry) => entry.disabledReason === undefined);
  if (enabled.length === 0) return disabledResolution(text, matches);

  // Gear 3. The full name also goes here: if the same provider/model appears twice in the directory, it is a problem with the host. The first one is picked silently.
  // It will leave no answer to "Which one should I choose?"
  const entry = enabled.length === 1 ? enabled[0]! : enabled.find((candidate) => candidate.current);
  if (entry === undefined) return ambiguousResolution(text, enabled);

  const options = resolveReasoningOptions(entry, level);
  if (options === undefined) {
    // `resolveReasoningOptions` only returns undefined when the gear is given but cannot match, so the level here must be present.
    return reasoningLevelUnknownResolution(text, entry, level ?? "");
  }

  const selection: ModelSelection = {
    // The registry's spelling, not the user's: `canonical` needs to be backfilled verbatim into the next call.
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...options,
  };
  return { ok: true, selection, entry, canonical: formatModelPickerValue(selection) };
}

/**
 * The normalized `subagent_model` -> a structured selection. **Used only inside the handler**: the
 * string that arrives there has already been through `resolveInput`, so failing to resolve it can
 * only mean someone bypassed normalization - that is a wiring fault and has to be shouted as one,
 * rather than silently dropping the model the user asked for (the subagent would quietly run on
 * the session model and nobody would notice).
 */
export function parseWorkflowSubagentModel(canonical: string | undefined): ModelSelection | undefined {
  if (canonical === undefined) return undefined;
  try {
    return parseModelPickerValue(canonical);
  } catch (cause) {
    throw new Error(
      `workflow subagent_model reached the handler un-canonicalised: ${canonical}`,
      { cause },
    );
  }
}

/**
 * The one sentence about the effective subagent model in the result copy (shared by
 * `CreateWorkflow` and `AmendWorkflow`, shaped after `describeWorkflowConcurrencyLimit`). **It
 * appears only when a model was set**: a run on the session model has nothing to say, and an extra
 * sentence would only make the model think it chose something.
 *
 * The half in parentheses is addressed to the model itself: it is most likely to read "the
 * subagent switched models" as "I switched too", and then repeat a false current model to the user
 * on the next turn.
 */
export function describeWorkflowSubagentModel(canonical: string | undefined): string {
  if (canonical === undefined) return "";
  return ` Subagents run on ${canonical} (the main agent stays on the session model).`;
}

/** The canonical id of a catalog entry (tiers excluded): the `id` in `ListModels` and the row in the failure list are the same shape. */
export function formatModelCatalogId(entry: ModelCatalogEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/**
 * Cuts out `$level`. The search start follows the provider separator (same as
 * `parseModelPickerValue`): a provider id never contains a `$`, but scanning the whole string as a
 * model name would cut a malformed string like `a$b/c` in the wrong place.
 */
function splitReasoningLevel(text: string): { reference: string; level?: string } {
  const providerSeparatorIndex = text.indexOf("/");
  const searchFrom = providerSeparatorIndex + 1;
  const index = text.indexOf(ZCODE_MODEL_REASONING_SEPARATOR, searchFrom);
  // The empty side (`$high`, `glm$`) doesn't count as a gear: that's a misspelling, making it fall to not_found to list.
  if (index <= searchFrom || index >= text.length - 1) return { reference: text };
  return { reference: text.slice(0, index), level: text.slice(index + 1) };
}

/** The candidate set for tiers 1 and 2: with a `/` it is compared as a full name, without one as a bare `modelId`. */
function matchEntries(reference: string, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const providerSeparatorIndex = reference.indexOf("/");
  if (providerSeparatorIndex > 0) {
    const providerId = reference.slice(0, providerSeparatorIndex);
    const modelId = reference.slice(providerSeparatorIndex + 1);
    return entries.filter(
      (entry) => sameToken(entry.providerId, providerId) && sameToken(entry.modelId, modelId),
    );
  }
  return entries.filter((entry) => sameToken(entry.modelId, reference));
}

/**
 * Tier selection. Returning `undefined` means the given tier is illegal (the call site answers
 * `reasoning_level_unknown` on that basis); returning `{}` means this model carries no tiers - note
 * that this is not the same thing as "the tier is the empty string", so it cannot be handled with
 * a nullish merge.
 */
function resolveReasoningOptions(
  entry: ModelCatalogEntry,
  level: string | undefined,
): { options?: { reasoningLevel: string } } | undefined {
  if (level !== undefined) {
    // The registry's own spelling wins: the `HIGH` typed by the user must be changed to `high` in the directory, otherwise the canonical backfill will be deformed once.
    const matched = entry.reasoningLevels.find((candidate) => sameToken(candidate, level));
    return matched === undefined ? undefined : { options: { reasoningLevel: matched } };
  }
  if (entry.reasoningLevels.length === 0 || entry.defaultReasoningLevel === undefined) return {};
  return { options: { reasoningLevel: entry.defaultReasoningLevel } };
}

/**
 * Not found: list the **selectable** ids. Disabled ones do not enter the list - making the model
 * pick from a list it could not use anyway only buys a second failure. The current session's entry
 * is tagged `[current]`: it is the equivalent of "set nothing", and marking it is what lets the
 * model know that choosing it is the same as choosing nothing.
 */
function notFoundResolution(text: string, entries: ModelCatalogEntry[]): ModelReferenceResolution {
  const candidates = entries.filter((entry) => entry.disabledReason === undefined);
  const shown = candidates.slice(0, MODEL_REFERENCE_CANDIDATE_LINES);
  const overflow = candidates.length - shown.length;
  const lines = shown.map(
    (entry) => `${formatModelCatalogId(entry)}${entry.current ? " [current]" : ""}`,
  );
  if (overflow > 0) lines.push(`… and ${overflow} more.`);
  const body =
    candidates.length === 0
      ? "No models are configured on this host."
      : ["Available models:", ...lines].join("\n");
  return {
    ok: false,
    reason: "not_found",
    message: `No configured model matches \`${text}\`. ${body}\n\nPass one of these ids, or call ListModels.`,
    candidates,
  };
}

/** The same name hangs off several providers and none of them is the current session's: the caller has to write the full name. */
function ambiguousResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map((entry) => formatModelCatalogId(entry));
  return {
    ok: false,
    reason: "ambiguous",
    message: `\`${text}\` is configured under more than one provider:\n${lines.join("\n")}\n\nPass the full \`providerId/modelId\` of the one you want.`,
    candidates,
  };
}

/** Only disabled entries match: say the reason along with it, otherwise the user sees "this model does not exist" while it is plainly in the list. */
function disabledResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map(
    (entry) => `${formatModelCatalogId(entry)} — ${entry.disabledReason}`,
  );
  return {
    ok: false,
    reason: "disabled",
    message: `\`${text}\` matches a model that cannot be used on this host:\n${lines.join("\n")}\n\nResolve that with the user, or call ListModels and pick another id.`,
    candidates,
  };
}

/** Illegal tier: the model was identified correctly, only the tier was mistyped - so the list offers the tiers of **this model**, not of the whole catalog. */
function reasoningLevelUnknownResolution(
  text: string,
  entry: ModelCatalogEntry,
  level: string,
): ModelReferenceResolution {
  const id = formatModelCatalogId(entry);
  const levels =
    entry.reasoningLevels.length === 0
      ? `${id} has no reasoning levels — drop the \`$\` suffix.`
      : `Its levels are: ${entry.reasoningLevels.join(", ")}.${
          entry.defaultReasoningLevel === undefined
            ? ""
            : ` Omit the suffix to use ${entry.defaultReasoningLevel}.`
        }`;
  return {
    ok: false,
    reason: "reasoning_level_unknown",
    message: `\`${level}\` is not a reasoning level of ${id}. ${levels}`,
    candidates: [entry],
  };
}

/** How ids are compared: trimmed on both ends, then case-insensitive. An id in the registry is an identifier, not free text. */
function sameToken(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
