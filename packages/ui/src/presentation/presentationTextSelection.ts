import type { PresentationElementBounds, PresentationPageSize } from "@/presentation/types.js";

interface PresentationElementTextSelectionOptions {
  selection: Selection | null;
  renderSurface: HTMLElement | null;
  pageSize: PresentationPageSize;
  elementBounds: PresentationElementBounds;
  elementText?: string;
}

function getElementClientBounds(
  renderSurface: HTMLElement,
  pageSize: PresentationPageSize,
  elementBounds: PresentationElementBounds,
) {
  const surfaceRect = renderSurface.getBoundingClientRect();
  if (
    surfaceRect.width <= 0 ||
    surfaceRect.height <= 0 ||
    pageSize.width <= 0 ||
    pageSize.height <= 0
  ) {
    return null;
  }
  const scaleX = surfaceRect.width / pageSize.width;
  const scaleY = surfaceRect.height / pageSize.height;
  const left = surfaceRect.left + elementBounds.x * scaleX;
  const top = surfaceRect.top + elementBounds.y * scaleY;
  return {
    left,
    top,
    right: left + elementBounds.width * scaleX,
    bottom: top + elementBounds.height * scaleY,
  };
}

function isRectCenteredInside(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  return (
    centerX >= bounds.left &&
    centerX <= bounds.right &&
    centerY >= bounds.top &&
    centerY <= bounds.bottom
  );
}

function getSelectedTextNodeSlice(range: Range, node: Text) {
  try {
    if (!range.intersectsNode(node)) {
      return null;
    }
  } catch {
    return null;
  }
  const startOffset =
    range.startContainer === node ? Math.min(range.startOffset, node.data.length) : 0;
  const endOffset =
    range.endContainer === node ? Math.min(range.endOffset, node.data.length) : node.data.length;
  if (endOffset <= startOffset) {
    return null;
  }
  return { startOffset, endOffset };
}

/**
 * Extracts only the text inside the bounds of the currently highlighted PPTX element from the
 * browser Selection.
 *
 * Why: a single native selection can span multiple renderer DOM elements; the reference cannot use
 * Selection.toString() directly, or content from adjacent shapes/table cells would be pulled into
 * the current element's reference.
 */
export function getPresentationElementSelectedText({
  selection,
  renderSurface,
  pageSize,
  elementBounds,
  elementText,
}: PresentationElementTextSelectionOptions): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !renderSurface) {
    return null;
  }
  const clientBounds = getElementClientBounds(renderSurface, pageSize, elementBounds);
  if (!clientBounds) {
    return null;
  }

  const ownerDocument = renderSurface.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const selectedParts: string[] = [];
  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const selectionRange = selection.getRangeAt(rangeIndex);
    if (selectionRange.collapsed) {
      continue;
    }
    const walker = ownerDocument.createTreeWalker(renderSurface, showText);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const textNode = current as Text;
      const slice = getSelectedTextNodeSlice(selectionRange, textNode);
      if (!slice) {
        continue;
      }
      const fragmentRange = ownerDocument.createRange();
      fragmentRange.setStart(textNode, slice.startOffset);
      fragmentRange.setEnd(textNode, slice.endOffset);
      const belongsToElement = Array.from(fragmentRange.getClientRects()).some((rect) =>
        isRectCenteredInside(rect, clientBounds),
      );
      const selectedPart = textNode.data.slice(slice.startOffset, slice.endOffset);
      const comparablePart = selectedPart.trim();
      if (
        belongsToElement &&
        (!comparablePart || !elementText || elementText.includes(comparablePart))
      ) {
        selectedParts.push(selectedPart);
      }
    }
  }

  return selectedParts.join("").trim() || null;
}
