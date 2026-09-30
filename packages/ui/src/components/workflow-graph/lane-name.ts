import { laneClassOf, type LaneClass, type WorkflowLaneData } from "./types.js";
import { formatNamePattern, type NamePattern } from "./name-pattern.js";

/**
 * The single policy point for lane display names.
 *
 * A site id (`actor#3`) is **identity**: the journal's key, the anchor in the hover title, the
 * handle you grab when troubleshooting. A display name is **presentation**. Mixing the two puts a
 * lane labeled "actor#3" in the UI — that is using a key as a name. Names come from exactly two
 * places: the name written in the script (shown verbatim, since localizing it would mean rewriting
 * the author's words), and the localized fallback used when the analysis cannot find a name.
 *
 * Why the fallback has to happen at render time: the projection (flow-elements.ts) is a memoized
 * pure function with no notion of language. Baking localized copy into the projection means that
 * when the user switches language mid-session that string becomes stale text (the workspace /
 * unresolved lanes have always been localized at render time, for exactly this reason). So the
 * projection only moves data; the copy is shaped here.
 */

/**
 * Every input needed to decide a lane's display name, minus the id: the id is identity and never
 * takes part in naming. Both `LaneHead` and the candidate lane reference (`LaneRef`) satisfy this
 * shape, so the two call sites share one policy.
 */
export interface LaneNaming {
  laneClass: LaneClass;
  /**
   * The name given by `agent("planner")` in the script; absent when the analysis cannot find the
   * literal.
   */
  name?: string;
  /**
   * When the name is interpolated (`` agent(`Researcher${i + 1}`) ``), the literals at both ends of the
   * template. Ranked after `name` and before the anonymous fallback: it says one more true thing
   * than "Anonymous Subagent", yet it is not the word the author wrote down verbatim.
   */
  namePattern?: NamePattern;
  /**
   * The 1-based ordinal when several anonymous agent lanes coexist in one graph; absent when there
   * is only one.
   */
  anonymousIndex?: number;
}

/**
 * The minimal shape of `IntlInstance["formatMessage"]`. The helper needs only this function and
 * does not touch React, so the policy itself can be unit tested with a fake formatter.
 */
export type LaneNameFormatter = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/**
 * Synthetic lanes are not identified by name: they mean "what runs here", so their copy is fixed.
 */
const NAME_ID_BY_CLASS: Partial<Record<LaneClass, string>> = {
  unresolved: "chat.toolCall.workflow.graph.lane.unresolved",
  workspace: "chat.toolCall.workflow.graph.lane.script",
};

export function laneDisplayName(lane: LaneNaming, formatMessage: LaneNameFormatter): string {
  const classNameId = NAME_ID_BY_CLASS[lane.laneClass];
  if (classNameId !== undefined) return formatMessage({ id: classNameId });
  // The author's original words appear as they are: localizing it means changing the author's words.
  if (lane.name !== undefined) return lane.name;
  // The name is interpolated: the shape is still the author's words, so it is also not localized, just an ellipsis is added.
  const patterned = formatNamePattern(lane.namePattern);
  if (patterned !== undefined) return patterned;
  // Numbers only appear when distinction is needed: there is only one anonymous lane in the picture, and the 1 in "Unnamed Agent 1" says nothing.
  return lane.anonymousIndex === undefined
    ? formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
    : formatMessage(
        { id: "chat.toolCall.workflow.graph.lane.anonymousIndexed" },
        { index: lane.anonymousIndex },
      );
}

/**
 * A reference to a lane: identity (`id`) plus every ingredient the display name needs. **Never a
 * pre-assembled display string** — the anonymous fallback copy is only shaped by `laneDisplayName`
 * at render time; see the file header above.
 */
export interface LaneRef extends LaneNaming {
  id: string;
}

/**
 * A 1-based ordinal, handed in lane order to the agent lanes "without a name", and only when two or
 * more coexist: when the graph holds a single anonymous lane, the 1 in "Anonymous Subagent 1"
 * distinguishes nothing and is just noise.
 *
 * **Lanes with a pattern count as "named"** and stay out of this numbering: they are labeled
 * `Researcher…`, and hanging an anonymous ordinal on top would only make the numbers disagree with the
 * number of anonymous lanes actually visible on screen. Two patterns that happen to be identical do
 * collide — the same thing that happens when two lanes are literally both named `"worker"` — so no
 * new disambiguation is owed here.
 *
 * The count is language-independent, which is why it belongs at this layer (and is unit testable);
 * the copy itself is only shaped at render time.
 */
function anonymousLaneIndexes(lanes: readonly WorkflowLaneData[]): Map<string, number> {
  const anonymous = lanes.filter(
    (lane) =>
      lane.name === undefined &&
      formatNamePattern(lane.namePattern) === undefined &&
      laneClassOf(lane.id) === "agent",
  );
  if (anonymous.length < 2) return new Map();
  return new Map(anonymous.map((lane, index) => [lane.id, index + 1]));
}

/**
 * Lane id → naming ingredients (not a display string).
 *
 * Three consumers share this one source: the graph's roster, the step card's candidate lanes, and
 * the instance selector of the transcript drill-down. They **must be same-sourced** — an anonymous
 * number means "the nth anonymous lane in the graph", and computing it twice is bound to disagree
 * eventually, which shows up as "Unnamed agent 2" in the selector sitting opposite "Unnamed agent
 * 1" in the graph.
 *
 * It lives here rather than in the projection layer (flow-elements.ts) so that consumers which do
 * not draw the graph (drill-down resolution is a pure function) do not have to pull React Flow into
 * their dependencies just for a set of naming ingredients. A lane id that is absent from the graph
 * is defaulted by the caller to `{id, laneClass}`: a future change such as per-site specialization
 * should not break the drill-down.
 */
export function laneRefsById(lanes: readonly WorkflowLaneData[]): Map<string, LaneRef> {
  const anonymousIndexes = anonymousLaneIndexes(lanes);
  return new Map(
    lanes.map((lane) => {
      const anonymousIndex = anonymousIndexes.get(lane.id);
      return [
        lane.id,
        {
          id: lane.id,
          laneClass: laneClassOf(lane.id),
          ...(lane.name === undefined ? {} : { name: lane.name }),
          ...(lane.namePattern === undefined ? {} : { namePattern: lane.namePattern }),
          ...(anonymousIndex === undefined ? {} : { anonymousIndex }),
        },
      ];
    }),
  );
}
