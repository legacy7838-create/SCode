import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const runtimeRequire = createRequire(import.meta.url);
const GENERATED_SOURCE_ASSIGNMENT = /const source\s*=\s*/;

let cachedSource: string | undefined;

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") {
    throw new Error("Playwright injected source assignment is not a string literal");
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  throw new Error("Playwright injected source string literal is unterminated");
}

/**
 * Playwright 1.59's generated injected script is not exposed as a public export.
 * DOM snapshot relies on the Apache-2.0 licensed Playwright runtime; here we only read the
 * corresponding string literal out of the pinned-version dependency and cache it, which avoids
 * vendoring a several-hundred-thousand-character copy of the generated code and avoids falling
 * back to hand-written ARIA guessing.
 */
export function getPlaywrightInjectedScriptSource(): string {
  if (cachedSource) return cachedSource;

  const packageJsonPath = runtimeRequire.resolve("playwright-core/package.json");
  const generatedSourcePath = join(
    dirname(packageJsonPath),
    "lib",
    "generated",
    "injectedScriptSource.js",
  );
  const generatedModule = readFileSync(generatedSourcePath, "utf8");
  const assignment = GENERATED_SOURCE_ASSIGNMENT.exec(generatedModule);
  if (!assignment) {
    throw new Error("Unable to locate Playwright injected source assignment");
  }
  const literalStart = assignment.index + assignment[0].length;
  const literalEnd = readStringLiteralEnd(generatedModule, literalStart);
  const literal = generatedModule.slice(literalStart, literalEnd);
  // Here only a single string literal in a fixed dependency is parsed; the generated module is not executed, and the web page content is not touched.
  const decoded: unknown = runInNewContext(literal, Object.create(null), { timeout: 1_000 });
  if (
    typeof decoded !== "string" ||
    !decoded.includes("module.exports = __toCommonJS(injectedScript_exports)") ||
    !decoded.includes("incrementalAriaSnapshot")
  ) {
    throw new Error("Playwright injected source failed integrity checks");
  }
  cachedSource = decoded;
  return decoded;
}
