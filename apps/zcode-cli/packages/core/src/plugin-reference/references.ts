// Strict canonical parsing of Plugin dialogue references.
// Contract:
// - Only accept Markdown link destinations in the form of `plugin://stable-id`, and the protocol name is case-sensitive (lowercase only).
// - stable-id must be `name@marketplace`, both segments match [A-Za-z0-9][A-Za-z0-9._-]*, total length ≤ 256.
// - Reject query, fragment, credentials, whitespace, control characters, and `%` (no implicit percent-decoding).
// - The identity only comes from destination; label never participates in parsing.

const PLUGIN_REFERENCE_SCHEME = "plugin://";
// Consistent with mentionMarkdown's link syntax: label supports \ escaping, and destination supports <...> or bare form.
const MARKDOWN_LINK_PATTERN =
  /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/g;
const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_PLUGIN_REFERENCES_PER_TURN = 8;
const MAX_PLUGIN_STABLE_ID_LENGTH = 256;

/**
 * Validates whether a candidate string is a strictly well-formed Plugin stable ID (`name@marketplace`).
 * The same validation is used by the parser and as a defense on the reminder output side (fail closed).
 */
export function isValidPluginStableId(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLUGIN_STABLE_ID_LENGTH) {
    return false;
  }
  const separatorIndex = candidate.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== candidate.lastIndexOf("@")) {
    return false;
  }
  const name = candidate.slice(0, separatorIndex);
  const marketplace = candidate.slice(separatorIndex + 1);
  // Segment-level character set verification is the complete security boundary: query/fragment/credentials/blank/control characters/% are not present
  // [A-Za-z0-9._-] set, will always be rejected without any implicit percent-decoding or tolerant matching.
  return PLUGIN_ID_SEGMENT_PATTERN.test(name) && PLUGIN_ID_SEGMENT_PATTERN.test(marketplace);
}

function parsePluginDestination(destination: string): string | null {
  // Protocol names are case-sensitive: neither `Plugin://` nor `PLUGIN://` are accepted.
  if (!destination.startsWith(PLUGIN_REFERENCE_SCHEME)) {
    return null;
  }
  const stableId = destination.slice(PLUGIN_REFERENCE_SCHEME.length);
  if (!isValidPluginStableId(stableId)) {
    return null;
  }
  return stableId;
}

function isPluginSchemeDestination(destination: string): boolean {
  // Only destinations "intended to be plugin protocols" are counted in the invalid statistics;
  // Case variants (Plugin://, etc.) are also counted as intent hits but parsing fails, preventing label spoofing and bypassing statistics.
  return /^plugin:\/\//i.test(destination);
}

export interface ExtractPluginReferencesResult {
  /** The references, deduplicated by stable ID and ordered by first appearance in the body. */
  references: string[];
  /** How many references were dropped for exceeding the per-turn cap (fail closed; the caller records a debug truncated). */
  truncatedCount: number;
  /** How many destinations matched the plugin protocol intent but failed to parse (the format-level rejection before unknown). */
  invalidCount: number;
}

/**
 * Extracts Plugin references (stable IDs) from canonical user text.
 * Identity comes only from the link destination; the Markdown label plays no part at all.
 */
export function extractPluginReferences(input: string): ExtractPluginReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!isPluginSchemeDestination(destination)) {
      continue;
    }
    const stableId = parsePluginDestination(destination);
    if (stableId === null) {
      invalidCount++;
      continue;
    }
    if (seen.has(stableId)) {
      continue;
    }
    if (references.length >= MAX_PLUGIN_REFERENCES_PER_TURN) {
      truncatedCount++;
      continue;
    }
    seen.add(stableId);
    references.push(stableId);
  }

  return { references, truncatedCount, invalidCount };
}
