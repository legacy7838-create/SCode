/**
 * IDs, URLs, keys and JSON in the Provider / Model configuration are technical fields, not natural
 * language. Spelling checks and autocorrect are disabled across the board, so a model ID never gets
 * a misleading red underline or gets rewritten by the system.
 */
export const TECHNICAL_INPUT_ATTRIBUTES = {
  autoCapitalize: "none",
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;
