import {
  $getCharacterOffsets,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import { $isPromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

/**
 * The editor text is for the caret; business output reads the canonical value explicitly and must
 * not overwrite TextNode text semantics.
 */
export function $getPromptMarkdown(node: LexicalNode = $getRoot()): string {
  if ($isPromptMentionNode(node)) return node.getMarkdown();
  if (!$isElementNode(node)) return node.getTextContent();
  const children = node.getChildren();
  return children
    .map(
      (child, index) =>
        $getPromptMarkdown(child) +
        ($isElementNode(child) && !child.isInline() && index < children.length - 1 ? "\n\n" : ""),
    )
    .join("");
}

/**
 * Consistent with Lexical RangeSelection's paragraph/endpoint rules, replacing only the actually
 * selected tokens with their canonical form.
 */
export function $getPromptSelectionMarkdown(selection: RangeSelection): string {
  if (selection.isCollapsed()) return "";
  const nodes = selection.getNodes();
  const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
  const forward = selection.anchor.isBefore(selection.focus);
  const start = forward ? anchorOffset : focusOffset;
  const end = forward ? focusOffset : anchorOffset;
  let result = "";
  let previousWasElement = true;
  for (const [index, node] of nodes.entries()) {
    if ($isElementNode(node) && !node.isInline()) {
      if (!previousWasElement) result += "\n";
      previousWasElement = !node.isEmpty();
      continue;
    }
    previousWasElement = false;
    let text = node.getTextContent();
    if ($isTextNode(node)) {
      let from = index === 0 ? start : 0;
      let to = index === nodes.length - 1 ? end : text.length;
      // When two element points wrap the same text node, offset is the child node index rather than a character.
      if (
        nodes.length === 1 &&
        selection.anchor.type === "element" &&
        selection.focus.type === "element" &&
        selection.anchor.offset !== selection.focus.offset
      ) {
        from = 0;
        to = text.length;
      }
      text = text.slice(from, to);
      if (text && $isPromptMentionNode(node)) text = node.getMarkdown();
    }
    result += text;
  }
  return result;
}

/**
 * Both cut and copy treat intersecting tokens as a whole, but must not expand a selection that
 * merely touches a boundary.
 */
export function $getAtomicPromptSelection(selection: RangeSelection): RangeSelection {
  const normalized = selection.clone();
  if (normalized.isCollapsed()) return normalized;
  const [start, end] = normalized.isBackward()
    ? [normalized.focus, normalized.anchor]
    : [normalized.anchor, normalized.focus];
  const startNode = start.getNode();
  const endNode = end.getNode();
  if (
    start.type === "text" &&
    $isPromptMentionNode(startNode) &&
    start.offset < startNode.getTextContentSize()
  ) {
    start.set(start.key, 0, "text");
  }
  if (end.type === "text" && $isPromptMentionNode(endNode) && end.offset > 0) {
    end.set(end.key, endNode.getTextContentSize(), "text");
  }
  return normalized;
}
