export type PromptInputTrigger = "/" | "@" | "$" | "#";

export interface ActivePromptInputTrigger {
  trigger: PromptInputTrigger;
  query: string;
}

export function getPromptInputTriggerSignature(
  activeTrigger: ActivePromptInputTrigger | null,
): string | null {
  return activeTrigger ? `${activeTrigger.trigger}:${activeTrigger.query}` : null;
}

export interface PromptInputSuggestionItem {
  id: string;
  trigger: PromptInputTrigger;
  value: string;
  label: string;
  description: string;
  keywords?: string[];
  data?: {
    path?: string;
    scope?: "built-in" | "workspace" | "user" | "plugin";
    source?: "built-in" | "user" | "plugin";
    model?: string;
  };
}

type PromptInputReplacementCandidates = string | readonly string[];

const ACTIVE_TRIGGER_RE = /(^|\s)([/@$#¥￥])([^\s/@$#¥￥]*)$/;
// Chinese input usually does not insert spaces in sentences; only relax @ to avoid changing the trigger boundaries of slash, skill, and session panels.
const ACTIVE_MENTION_TRIGGER_RE =
  /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s/@$#¥￥]*)$/u;
// After relaxing the Chinese characters immediately adjacent to @, `contact email@example.com` / `user@example.company` will be treated as mention.
// Reject queries in domain name form (`x.y`) only when Chinese characters are directly adjacent to @; after Chinese punctuation (`Look, @foo.bar`) and
// `@foo.bar` after the space is not in the form of a mailbox and remains triggered.
const DOMAIN_LIKE_QUERY_RE = /\S\.\S/;
const HAN_PREFIX_RE = /\p{Script=Han}/u;
const ACTIVE_TRIGGER_TAIL_RE = /^[^\s/@$#¥￥]*/;

function normalizePromptInputTriggerAlias(trigger: string): PromptInputTrigger {
  if (trigger === "¥" || trigger === "￥") {
    // Some keyboards/input methods will produce `¥` or full-width `￥` when inputting skill trigger.
    // Here we only normalize the trigger semantics to `$` and let it evoke the skill panel; we do not rewrite the characters actually entered by the user in the input layer.
    return "$";
  }

  return trigger as PromptInputTrigger;
}

function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

function scorePromptInputSuggestion(
  suggestion: PromptInputSuggestionItem,
  query: string,
): number | null {
  const valueScore = scoreFuzzyMatch(suggestion.value, query);
  const labelScore = scoreFuzzyMatch(suggestion.label, query);
  const descriptionScore = scoreFuzzyMatch(suggestion.description, query);
  const keywordScore = Math.min(
    ...(suggestion.keywords ?? []).map((keyword) => {
      const score = scoreFuzzyMatch(keyword, query);
      return score === null ? Number.POSITIVE_INFINITY : score + 450;
    }),
    Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    valueScore ?? Number.POSITIVE_INFINITY,
    labelScore !== null ? labelScore + 50 : Number.POSITIVE_INFINITY,
    descriptionScore !== null ? descriptionScore + 250 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

export function extractActivePromptInputTrigger(
  textBeforeCursor: string,
): ActivePromptInputTrigger | null {
  const match =
    ACTIVE_MENTION_TRIGGER_RE.exec(textBeforeCursor) ?? ACTIVE_TRIGGER_RE.exec(textBeforeCursor);
  if (!match) {
    return null;
  }
  if (HAN_PREFIX_RE.test(match[1] ?? "") && DOMAIN_LIKE_QUERY_RE.test(match[3] ?? "")) {
    return null;
  }

  return {
    trigger: normalizePromptInputTriggerAlias(match[2] ?? ""),
    query: match[3] ?? "",
  };
}

export function getActivePromptInputTokenTailLength(
  activeTrigger: ActivePromptInputTrigger,
  textAfterCursor: string,
  replacementCandidates: PromptInputReplacementCandidates,
): number {
  if (activeTrigger.query.length === 0) {
    // When the user inserts a naked trigger before existing text, the text after the cursor is not the completion part of the current token.
    // Previously, these texts would be replaced together as tail, resulting in the @/#/$// candidate being selected and the subsequent text cleared.
    return 0;
  }

  const tailMatch = ACTIVE_TRIGGER_TAIL_RE.exec(textAfterCursor);
  const tailText = tailMatch?.[0] ?? "";
  if (!tailText) {
    return 0;
  }

  const normalizedQuery = activeTrigger.query.toLowerCase();
  const candidates = Array.isArray(replacementCandidates)
    ? replacementCandidates
    : [replacementCandidates];
  let matchedTailLength = 0;

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim().replace(/^[/@$#¥￥]+/, "");
    if (!candidate) {
      continue;
    }

    const normalizedCandidate = candidate.toLowerCase();
    if (!normalizedCandidate.startsWith(normalizedQuery)) {
      continue;
    }

    const expectedTail = candidate.slice(activeTrigger.query.length);
    if (!expectedTail) {
      continue;
    }

    const comparableLength = Math.min(tailText.length, expectedTail.length);
    const typedTail = tailText.slice(0, comparableLength);
    // If the text immediately following the complete `/goal` is regarded as the tail of the same token, the entire paragraph will be deleted.
    // Here we only delete the short section that matches "candidate value without input suffix", such as `al` in `/go|al`.
    if (expectedTail.toLowerCase().startsWith(typedTail.toLowerCase())) {
      matchedTailLength = Math.max(matchedTailLength, comparableLength);
    }
  }

  return matchedTailLength;
}

export function filterPromptInputSuggestions(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): PromptInputSuggestionItem[] {
  if (query === null) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return suggestions;
  }

  return suggestions
    .map((suggestion, index) => {
      const bestScore = scorePromptInputSuggestion(suggestion, normalizedQuery);
      if (bestScore === null) {
        return null;
      }

      return {
        index,
        score: bestScore,
        suggestion,
      };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        score: number;
        suggestion: PromptInputSuggestionItem;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return left.suggestion.label.localeCompare(right.suggestion.label);
    })
    .map((item) => item.suggestion);
}

export function getBestPromptInputSuggestionIndex(
  suggestions: PromptInputSuggestionItem[],
  query: string | null,
): number {
  const normalizedQuery = query?.trim().toLowerCase() ?? "";
  if (!normalizedQuery) {
    return 0;
  }

  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  suggestions.forEach((suggestion, index) => {
    const score = scorePromptInputSuggestion(suggestion, normalizedQuery);
    if (score === null) {
      return;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}
