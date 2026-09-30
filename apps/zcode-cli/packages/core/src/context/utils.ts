// ============================================================
// Token Estimation
// ============================================================

import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";

/**
 * Estimates the number of tokens in a text
 * Uses the shared character estimation divisor, keeping extra weight for CJK characters
 * This is a rough estimate, good enough for debugging and monitoring
 */
export function estimateTokens(text: string): number {
  // Chinese characters generally take up more tokens than English characters, so they are counted as two estimated characters.
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
