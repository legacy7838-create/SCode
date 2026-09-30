import type { ModelSelection } from "@zcode/shared";
import { parseProviderQualifiedModelSelection } from "../app/provider-registry-selection.js";

export function formatProtocolModelSelection(ref: ModelSelection): string {
  return `${ref.providerId}/${ref.modelId}`;
}

function modelSelectionFromString(input: string): ModelSelection {
  const selection = parseProviderQualifiedModelSelection(input);
  if (!selection) throw new Error(`Invalid provider-qualified model selection: ${input}`);
  return selection;
}

/** getModel() returns nothing when no App is bound; the read protocol must not turn a legitimate empty state back into a recovery exception. */
export function optionalModelSelectionFromString(input: string): ModelSelection | undefined {
  return input.trim() ? modelSelectionFromString(input) : undefined;
}
