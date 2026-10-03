/**
 * The post-parse bash permission policy — Rust, over a grammar-parsed command line.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 4).
 *
 * Split out of `subagentProfile.ts` because that file reached the repository's maximum file
 * length. The grammar parse stays in TypeScript; this is everything after it.
 */

import { loadNative } from "./loader.js";

/** One parsed command, as the grammar produced it. */
export interface ParsedBashCommand {
  name: string;
  argv: readonly string[];
  commandText: string;
  envAssignments: readonly ({ name?: string } | undefined)[];
  redirects: readonly { operator: string; target: string }[];
  operatorBefore?: "&&" | "||" | "|" | "|&" | "sequence";
}

/** The grammar's findings about a whole command line. */
export interface BashAnalysis {
  commands: readonly ParsedBashCommand[];
  hasParseErrors: boolean;
  hasRedirects: boolean;
  hasDynamicWords: boolean;
  hasUnsupportedSyntax: boolean;
}

interface NativeBashSemanticsModule {
  evaluateBashSemanticsJson(requestJson: string): string;
}

let cachedBashSemantics: NativeBashSemanticsModule | null = null;

function bashSemanticsModule(): NativeBashSemanticsModule {
  cachedBashSemantics ??= loadNative<NativeBashSemanticsModule>("zcode-subagent-profile");
  return cachedBashSemantics;
}

/**
 * The whole post-parse bash permission policy: is the analysis usable, is the line read-only,
 * is it silent.
 *
 * All three come from ONE Rust call over ONE analysis, so they cannot disagree with each other.
 * The grammar parse itself stays in TypeScript — it is the only thing left there.
 */
export function evaluateBashSemantics(
  analysis: BashAnalysis,
  workingDirectory?: string,
): { permissionSafe: boolean; readOnly: boolean; silent: boolean } {
  return JSON.parse(
    bashSemanticsModule().evaluateBashSemanticsJson(
      JSON.stringify({ analysis, workingDirectory: workingDirectory ?? null }),
    ),
  ) as { permissionSafe: boolean; readOnly: boolean; silent: boolean };
}

/**
 * `isBashCommandPermissionSafe` — Rust.
 *
 * The analysis type is the grammar's, so the conversion happens here; the rule itself is
 * `zcode-subagent-profile::gitruntimesafety`.
 */
export function isBashCommandPermissionSafe(analysis: {
  hasParseErrors: boolean;
  hasRedirects: boolean;
  hasDynamicWords: boolean;
  hasUnsupportedSyntax: boolean;
  commands: readonly ParsedBashCommand[];
}): boolean {
  return evaluateBashSemantics(analysis).permissionSafe;
}
