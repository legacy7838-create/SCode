import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * The only render site for the idea that “a name takes shape only at runtime”.
 *
 * The analyzer yields a shape, not a name: `` agent(`researcher${i + 1}`) `` cannot be folded into 8
 * concrete names (that would require expanding `map`, and the whole point of `×N` is to refuse that
 * expansion), so the only thing available is the literal at each end of the template. The
 * projection therefore just carries the two affixes over, and the ellipsis is filled in **here** —
 * the same reasoning as the anonymous fallback wording (see the header of lane-name.ts): the
 * projection is a memoized pure function, so both the wording and the glyph should be formed at
 * render time, and the projection should hold only data.
 *
 * The ellipsis (rather than `*` or `${…}`) is deliberate: it still reads as a name, and introduces
 * no new visual vocabulary.
 */
const ELLIPSIS = "…";

/**
 * The name shape of one lane / one card; the shape comes from the protocol, and no separate scheme
 * is established here.
 */
export type NamePattern = NonNullable<WorkflowCausalityGraphData["lanes"][number]["namePattern"]>;

/**
 * `{head: "researcher"}` → `researcher…`, `{tail: "-worker"}` → `…-worker`, both ends present → `a…b`.
 *
 * When both affixes are absent, returns undefined rather than a lone `…`: the analyzer never emits
 * such a pattern, but by contract `{}` does pass `.strict()`, and not covering for it here would
 * leave a meaningless ellipsis on screen.
 */
export function formatNamePattern(pattern: NamePattern | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ?? "";
  const tail = pattern.tail ?? "";
  if (head === "" && tail === "") return undefined;
  return `${head}${ELLIPSIS}${tail}`;
}
