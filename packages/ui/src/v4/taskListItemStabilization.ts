// Reference stabilization of task list rows (shared across lanes).
//
// sessions-index / Controller tasks-index ZCodeTaskMeta[] will be fully reconstructed for each content frame.
// Even if the content has not changed at all (for example, only the activity timestamp of the list but not consumption has been changed). Downstream treats "new array reference" as new data:
// Grouped view whole tree refresh, virtual machine weight measurement, workspace row cache is invalidate - manifested as
// "When the tool results are output on the right, the entire list on the left is reloaded." Here we do reference stabilization one by one: old objects are reused with equivalent content;
// The entire table is equivalent to reusing the old array, short-circuiting all memo and effects that depend on the identity of the array/element.
import type { ZCodeTaskMeta } from "@zcode/shared";

export function buildTaskListItemIdentityKey(meta: ZCodeTaskMeta): string {
  return `${meta.workspaceIdentity?.trim() || meta.workspacePath}::${meta.taskId}`;
}

/**
 * Structural equivalence: ignores key insertion order and treats `undefined` values as absent
 * (matching how JSON serializes).
 *
 * This deliberately does not compare with `JSON.stringify`: the upstream Controller / tasks-index
 * join builds objects with conditional spread in abundance (`...(x ? { k: v } : {})`), and equal
 * content in a different key order is never equal as a string, so stabilization would silently
 * degrade into "a brand-new reference every frame" — a silent regression where "the whole list
 * flickers once", with no error, no log, and no metric. Field-by-field comparison keeps the
 * equivalence check from depending on construction order as an implicit assumption, and
 * short-circuits at the first difference as a bonus.
 */
export function areStabilizedValuesEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areStabilizedValuesEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => areStabilizedValuesEquivalent(leftRecord[key], rightRecord[key]));
}

/**
 * Field-by-field equivalence (nested fields compared structurally; task meta is a small object, so
 * the cost is negligible).
 */
export function areTaskListItemsEquivalent(left: ZCodeTaskMeta, right: ZCodeTaskMeta): boolean {
  return areStabilizedValuesEquivalent(left, right);
}

/**
 * Reference stabilization: equivalent entries reuse the old object; when order and content are both
 * equal, the whole old array is reused.
 */
export function stabilizeTaskListItems<T extends ZCodeTaskMeta>(previous: T[], next: T[]): T[] {
  if (previous.length === 0) {
    return next;
  }
  const previousByKey = new Map(
    previous.map((meta) => [buildTaskListItemIdentityKey(meta), meta] as const),
  );
  let identical = previous.length === next.length;
  const stabilized = next.map((meta, index) => {
    const previousMeta = previousByKey.get(buildTaskListItemIdentityKey(meta));
    if (previousMeta && areTaskListItemsEquivalent(previousMeta, meta)) {
      if (identical && previous[index] !== previousMeta) {
        identical = false;
      }
      return previousMeta;
    }
    identical = false;
    return meta;
  });
  return identical ? previous : stabilized;
}
