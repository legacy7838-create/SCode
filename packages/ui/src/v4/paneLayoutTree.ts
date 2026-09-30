// Model and pure state machine of binary split tree in split-screen Layout layer.
// Alignment: Focus points to the pane of Layout,
// pane points to (workspaceScope, sessionId), and SessionDataLayer has zero awareness of the upper two layers.
//
// Design boundaries:
// - layout = binary split tree (VS Code editor groups model): any pane can be split right/down,
//   Nesting results in 2x2 equal grids; leaves capped at MAX_WORKBENCH_PANES (performance baseline 4 panes).
// - pane binding = { workspaceScope, sessionId }: pane comes with workspace ownership (including remote
//   remoteSessionId), no longer limited to the same workspace; the earlier version of "split" belongs to another workspace
//   "Do not render" rule is deleted - pane is resident across workspace tabs.
// - workspaceScope semantics = the primary workspace to which the session belongs, which is the connection routing key;
//   It is not "all paths that the session can reach" (the auxiliary path across workspace sessions in the future will be
//   session attribute, does not enter the layout layer).
// - The primary pane (workspace-main) is a reserved leaf: it does not enter panes, and the existing selection state is used for binding.
//   (activeTaskId → shell props), avoid double writing with zcodeSessionStore/tabStore;
//   tabStore (workspace tab semantics) doesn't move at all.
// All transfer functions have no side effects; if there are no changes, the original reference is returned (zustand avoids re-rendering).

/**
 * Fixed id of the primary pane (keeps the hardcoded paneId, so the testid contract is unchanged).
 */
export const V4_PRIMARY_PANE_ID = "workspace-main";

/**
 * Upper bound on leaf panes (the performance acceptance baseline "4 panes streaming at once without
 * dropped frames"; also a soft cap on the number of CLI child processes).
 */
export const MAX_WORKBENCH_PANES = 4;

/**
 * Split ratio bounds: the first subtree's share is at least 25% and at most 75% (dragging and
 * persistence share the same clamp).
 */
const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;
const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO;
  }
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/**
 * A pane's workspace ownership (= the session's primary workspace, the connection routing key).
 * - Local: only workspacePath;
 * - Remote (SSH/WSL): workspaceIdentity is required (Workspace Identity constraint), and
 *   remoteSessionId points at the connection in remoteWorkspaceSessionStore (resolved from the
 *   identity when omitted).
 */
export interface PaneWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
}

/**
 * One canonical form for identity/isolation semantics: workspaceKey = workspaceIdentity?.trim() ||
 * workspacePath.
 */
export function paneWorkspaceKey(scope: PaneWorkspaceScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function paneBindingMatchesSession(
  binding: PaneBinding | null | undefined,
  scope: PaneWorkspaceScope,
  sessionId: string,
): boolean {
  return Boolean(
    binding?.sessionId === sessionId &&
    paneWorkspaceKey(binding.workspaceScope) === paneWorkspaceKey(scope),
  );
}

export interface PaneBinding {
  /**
   * = the primary workspace a session belongs to (the connection routing key); auxiliary paths are
   * not included.
   */
  readonly workspaceScope: PaneWorkspaceScope;
  /**
   * The bound CLI session; null = draft (the empty-pane path: it binds in place after the first
   * createSession).
   */
  readonly sessionId: string | null;
  /**
   * A read-only pane does not render the composer/input; currently used for the child session
   * opened inline beside a subagent row.
   */
  readonly readOnly?: boolean;
  /**
   * A binding restored from persistence whose existence has not yet been verified against that
   * scope's sessions-index (the flag itself is not persisted). Present → confirmRestoredPaneSession
   * clears it; deleted → closePane collapses gracefully.
   */
  readonly restoredUnvalidated?: boolean;
}

export type SplitDirection = "row" | "column";

/** IDE-style drag split direction: left/up insert before the anchor, right/down insert after it. */
export type PaneSplitSide = "left" | "right" | "up" | "down";

export type PaneLayoutNode =
  | { readonly type: "leaf"; readonly paneId: string }
  | {
      readonly type: "split";
      /** Split node id (the lookup key for the drag CSS variable and setSplitRatio). */
      readonly id: string;
      readonly direction: SplitDirection;
      /** The first subtree's share, clamped to [0.25, 0.75]. */
      readonly ratio: number;
      readonly first: PaneLayoutNode;
      readonly second: PaneLayoutNode;
    };

export interface PaneLayoutSnapshot {
  readonly root: PaneLayoutNode;
  /**
   * Bindings for non-primary panes; the primary binding keeps using the shell props (activeTaskId)
   * and is not stored in this map.
   */
  readonly panes: Readonly<Record<string, PaneBinding>>;
  /** The single "current" pane for the whole app (a scalar in the Focus layer). */
  readonly focusedPaneId: string;
}

export const PRIMARY_LEAF: PaneLayoutNode = {
  type: "leaf",
  paneId: V4_PRIMARY_PANE_ID,
};

export const INITIAL_PANE_LAYOUT: PaneLayoutSnapshot = {
  root: PRIMARY_LEAF,
  panes: {},
  focusedPaneId: V4_PRIMARY_PANE_ID,
};

// ============================================================================
// Tree tool (unchanged path remains structurally shared = original reference).
// ============================================================================

/** Collects leaf paneIds in document order. */
export function leafPaneIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [node.paneId];
  }
  return [...leafPaneIds(node.first), ...leafPaneIds(node.second)];
}

export function countPanes(state: PaneLayoutSnapshot): number {
  return leafPaneIds(state.root).length;
}

/** Whether another pane can still be split off (leaf count < MAX_WORKBENCH_PANES). */
export function canAddPane(state: PaneLayoutSnapshot): boolean {
  return countPanes(state) < MAX_WORKBENCH_PANES;
}

function leafExists(node: PaneLayoutNode, paneId: string): boolean {
  if (node.type === "leaf") {
    return node.paneId === paneId;
  }
  return leafExists(node.first, paneId) || leafExists(node.second, paneId);
}

/**
 * Falls back to primary when the focused pane is not in the tree (e.g. just closed, or anomalous
 * restored data).
 */
export function effectiveFocusedPaneId(state: PaneLayoutSnapshot): string {
  return leafExists(state.root, state.focusedPaneId) ? state.focusedPaneId : V4_PRIMARY_PANE_ID;
}

/**
 * Allocates a new pane id: pane-<n>, where n = the highest existing index in the tree + 1 (no
 * collision with the reserved workspace-main/split ids).
 */
function allocatePaneId(root: PaneLayoutNode): string {
  let max = 0;
  for (const paneId of leafPaneIds(root)) {
    const match = /^pane-(\d+)$/.exec(paneId);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `pane-${max + 1}`;
}

function splitNodeIds(node: PaneLayoutNode): string[] {
  if (node.type === "leaf") {
    return [];
  }
  return [node.id, ...splitNodeIds(node.first), ...splitNodeIds(node.second)];
}

/**
 * Allocates a new split node id: n<k> (a short id, it ends up in the CSS variable name
 * --v4-split-<id>).
 */
function allocateSplitNodeId(root: PaneLayoutNode): string {
  let max = 0;
  for (const id of splitNodeIds(root)) {
    const match = /^n(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `n${max + 1}`;
}

/**
 * Replaces the paneId leaf with replacement; paths that do not match keep their original
 * references.
 */
function replaceLeaf(
  node: PaneLayoutNode,
  paneId: string,
  replacement: PaneLayoutNode,
): PaneLayoutNode {
  if (node.type === "leaf") {
    return node.paneId === paneId ? replacement : node;
  }
  const first = replaceLeaf(node.first, paneId, replacement);
  const second = replaceLeaf(node.second, paneId, replacement);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

/**
 * Removes a leaf: the parent split node collapses into the sibling subtree; returning null means
 * the whole tree was removed (only when the root is that leaf).
 */
function removeLeaf(node: PaneLayoutNode, paneId: string): PaneLayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const first = removeLeaf(node.first, paneId);
  if (first === null) {
    return node.second;
  }
  const second = removeLeaf(node.second, paneId);
  if (second === null) {
    return node.first;
  }
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

function replaceSplitRatio(node: PaneLayoutNode, splitId: string, ratio: number): PaneLayoutNode {
  if (node.type === "leaf") {
    return node;
  }
  if (node.id === splitId) {
    return node.ratio === ratio ? node : { ...node, ratio };
  }
  const first = replaceSplitRatio(node.first, splitId, ratio);
  const second = replaceSplitRatio(node.second, splitId, ratio);
  if (first === node.first && second === node.second) {
    return node;
  }
  return { ...node, first, second };
}

// ============================================================================
// Pure state machine (single test object)
// ============================================================================

/**
 * Splits at the anchor pane: the anchor leaf is replaced by a split node { anchor, new pane }, and
 * the new pane takes the binding (draft or an existing session) and assumes focus. anchor not in
 * the tree / leaf count at the limit → no-op (original reference).
 */
export function splitPaneAt(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  direction: SplitDirection,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction,
    ratio: DEFAULT_SPLIT_RATIO,
    first: { type: "leaf", paneId: anchorPaneId },
    second: { type: "leaf", paneId: newPaneId },
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Splits around the anchor pane: left/up put the new pane before the anchor, right/down put it
 * after. Drag-to-split has to preserve the user's directional intent; the older splitPaneAt keeps
 * its "anchor first, new pane after" contract.
 */
export function splitPaneAtSide(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const anchorLeaf: PaneLayoutNode = { type: "leaf", paneId: anchorPaneId };
  const newLeaf: PaneLayoutNode = { type: "leaf", paneId: newPaneId };
  const before = side === "left" || side === "up";
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: DEFAULT_SPLIT_RATIO,
    first: before ? newLeaf : anchorLeaf,
    second: before ? anchorLeaf : newLeaf,
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}

/**
 * Closes a pane: the leaf is removed, the parent split node collapses into the sibling subtree, and
 * the binding is removed. The primary cannot be closed; a pane not in the tree → no-op. When the
 * focus is on the pane being closed it goes back to primary. Closing a pane ≠ stopping the session:
 * it only unsubscribes the view, and the session keeps running in the CLI.
 */
export function closePane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (paneId === V4_PRIMARY_PANE_ID || !leafExists(state.root, paneId)) {
    return state;
  }
  const root = removeLeaf(state.root, paneId) ?? PRIMARY_LEAF;
  const panes = { ...state.panes };
  delete panes[paneId];
  return {
    root,
    panes,
    focusedPaneId: state.focusedPaneId === paneId ? V4_PRIMARY_PANE_ID : state.focusedPaneId,
  };
}

/**
 * Binds a session in place on a draft pane after its first createSession. No-op when the pane has
 * no binding / is unchanged (and carries no pending-verification flag).
 */
export function bindPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
  sessionId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding || (binding.sessionId === sessionId && !binding.restoredUnvalidated)) {
    return state;
  }
  // Real-time binding is authoritative and does not require further verification: rebuild without restoredUnvalidated.
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: { workspaceScope: binding.workspaceScope, sessionId },
    },
  };
}

/**
 * Replaces the complete session binding of a non-primary pane in place. After a draft split,
 * clicking an ordinary session only updated the shell activeTaskId, which let the new session
 * overwrite the primary draft; here the focused secondary's scope + session owner are replaced
 * first.
 */
export function replacePaneBinding(
  state: PaneLayoutSnapshot,
  paneId: string,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!state.panes[paneId] || paneId === V4_PRIMARY_PANE_ID) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: binding,
    },
    focusedPaneId: paneId,
  };
}

export function findPaneIdForSession(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): string | null {
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (paneBindingMatchesSession(binding, scope, sessionId)) {
      return paneId;
    }
  }
  return null;
}

/**
 * Commit of a drag resize: located by split node id, clamped to [25%, 75%]; returns the original
 * reference when unchanged.
 */
export function setSplitNodeRatio(
  state: PaneLayoutSnapshot,
  splitId: string,
  ratio: number,
): PaneLayoutSnapshot {
  const root = replaceSplitRatio(state.root, splitId, clampSplitRatio(ratio));
  if (root === state.root) {
    return state;
  }
  return { ...state, root };
}

/**
 * Focus a pane: only leaves that exist in the current tree are accepted, everything else is a no-op
 * (original reference).
 */
export function focusPane(state: PaneLayoutSnapshot, paneId: string): PaneLayoutSnapshot {
  if (state.focusedPaneId === paneId || !leafExists(state.root, paneId)) {
    return state;
  }
  return { ...state, focusedPaneId: paneId };
}

/**
 * Clears the pending-verification flag once a pane binding restored from persistence is verified
 * present by the sessions-index. No-op when there is no flag.
 */
export function confirmRestoredPaneSession(
  state: PaneLayoutSnapshot,
  paneId: string,
): PaneLayoutSnapshot {
  const binding = state.panes[paneId];
  if (!binding?.restoredUnvalidated) {
    return state;
  }
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
      },
    },
  };
}

/**
 * Sidebar / drill-down "open in a split": if the session is already in some pane (compared by
 * workspaceKey + sessionId, per the ownership/isolation semantics) → focus it; otherwise split the
 * currently focused pane to the right. At the limit with no existing pane → no-op.
 */
export function openSessionInNewPane(
  state: PaneLayoutSnapshot,
  scope: PaneWorkspaceScope,
  sessionId: string,
): PaneLayoutSnapshot {
  const workspaceKey = paneWorkspaceKey(scope);
  for (const [paneId, binding] of Object.entries(state.panes)) {
    if (
      binding.sessionId === sessionId &&
      paneWorkspaceKey(binding.workspaceScope) === workspaceKey
    ) {
      return focusPane(state, paneId);
    }
  }
  return splitPaneAt(state, effectiveFocusedPaneId(state), "row", {
    workspaceScope: scope,
    sessionId,
  });
}
