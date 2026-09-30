// Split screen layout calculation (pure function): split tree → absolute positioning expression for each leaf/divider.
// The leaves are rendered flat as direct child elements of the container (key = paneId stable) - splitting/closing just replaces rect,
// React does not rehang any surviving pane (virtualizer height measurement, scroll position, composer draft are all retained);
// If the tree is recursively nested and rendered, the entire tree will be re-hanged when the leaves are replaced with split containers.
// The rect expression refers to the split ratio CSS variable: changing a variable while dragging will affect all panes/separators
// Reflowed by CSS, zero React rendering (the "container CSS variables" scheme is generalized by split nodes).
import type { CSSProperties } from "react";
import type { PaneLayoutNode, SplitDirection } from "@/v4/paneLayoutTree.js";

/** CSS variable prefix for split ratios (one `--v4-split-<nodeId>` per split node). */
export const SPLIT_VAR_PREFIX = "--v4-split-";

/**
 * Absolutely positioned expression (without the calc() wrapper; the style side always uses
 * `calc(${expr})`).
 */
export interface RectExpr {
  left: string;
  top: string;
  width: string;
  height: string;
}

interface LeafLayout {
  paneId: string;
  rect: RectExpr;
}

interface DividerLayout {
  splitId: string;
  direction: SplitDirection;
  /**
   * The current ratio in the store (the drag start point + the container CSS variable's initial
   * value).
   */
  ratio: number;
  /**
   * The numeric fraction of the container's main axis occupied by this split node's region (drag
   * pixels → ratio conversion; ancestor ratios take the store values).
   */
  regionFraction: number;
  /** Expression for the split divider (position on the main axis). */
  boundary: string;
  /** Expressions for the cross-axis start / length. */
  crossStart: string;
  crossLength: string;
}

const ROOT_RECT: RectExpr = {
  left: "0%",
  top: "0%",
  width: "100%",
  height: "100%",
};

function collectNode(
  node: PaneLayoutNode,
  rect: RectExpr,
  widthFraction: number,
  heightFraction: number,
  leaves: LeafLayout[],
  dividers: DividerLayout[],
): void {
  if (node.type === "leaf") {
    leaves.push({ paneId: node.paneId, rect });
    return;
  }
  const ratioVar = `var(${SPLIT_VAR_PREFIX}${node.id}, ${node.ratio})`;
  if (node.direction === "row") {
    const boundary = `(${rect.left}) + (${rect.width}) * ${ratioVar}`;
    dividers.push({
      splitId: node.id,
      direction: "row",
      ratio: node.ratio,
      regionFraction: widthFraction,
      boundary,
      crossStart: rect.top,
      crossLength: rect.height,
    });
    collectNode(
      node.first,
      { ...rect, width: `(${rect.width}) * ${ratioVar}` },
      widthFraction * node.ratio,
      heightFraction,
      leaves,
      dividers,
    );
    collectNode(
      node.second,
      { ...rect, left: boundary, width: `(${rect.width}) * (1 - ${ratioVar})` },
      widthFraction * (1 - node.ratio),
      heightFraction,
      leaves,
      dividers,
    );
    return;
  }
  const boundary = `(${rect.top}) + (${rect.height}) * ${ratioVar}`;
  dividers.push({
    splitId: node.id,
    direction: "column",
    ratio: node.ratio,
    regionFraction: heightFraction,
    boundary,
    crossStart: rect.left,
    crossLength: rect.width,
  });
  collectNode(
    node.first,
    { ...rect, height: `(${rect.height}) * ${ratioVar}` },
    widthFraction,
    heightFraction * node.ratio,
    leaves,
    dividers,
  );
  collectNode(
    node.second,
    { ...rect, top: boundary, height: `(${rect.height}) * (1 - ${ratioVar})` },
    widthFraction,
    heightFraction * (1 - node.ratio),
    leaves,
    dividers,
  );
}

interface WorkbenchLayout {
  leaves: LeafLayout[];
  dividers: DividerLayout[];
}

export function collectWorkbenchLayout(root: PaneLayoutNode): WorkbenchLayout {
  const leaves: LeafLayout[] = [];
  const dividers: DividerLayout[] = [];
  collectNode(root, ROOT_RECT, 1, 1, leaves, dividers);
  return { leaves, dividers };
}

export function rectStyle(rect: RectExpr): CSSProperties {
  return {
    left: `calc(${rect.left})`,
    top: `calc(${rect.top})`,
    width: `calc(${rect.width})`,
    height: `calc(${rect.height})`,
  };
}

export function dividerStyle(divider: DividerLayout): CSSProperties {
  if (divider.direction === "row") {
    return {
      left: `calc(${divider.boundary})`,
      top: `calc(${divider.crossStart})`,
      height: `calc(${divider.crossLength})`,
      width: "9px",
      transform: "translateX(-50%)",
    };
  }
  return {
    top: `calc(${divider.boundary})`,
    left: `calc(${divider.crossStart})`,
    width: `calc(${divider.crossLength})`,
    height: "9px",
    transform: "translateY(-50%)",
  };
}
