interface TaskWorkbenchDragPreviewParams {
  clientX: number;
  clientY: number;
  dataTransfer: Pick<DataTransfer, "setDragImage">;
  source: HTMLElement;
}

function createTaskWorkbenchDragPreview({
  clientX,
  clientY,
  dataTransfer,
  source,
}: TaskWorkbenchDragPreviewParams): () => void {
  const document = source.ownerDocument;
  const sourceRect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.dataset.taskWorkbenchDragPreview = "true";
  // The transparent bottom of the default drag preview will cause the Project task to lack borders in the floating layer;
  // Keep the original row content and only add the surface style used by Grouped drag overlay.
  preview.classList.add("border", "border-border", "bg-background", "shadow-lg");
  preview.style.position = "fixed";
  preview.style.left = "-10000px";
  preview.style.top = "-10000px";
  preview.style.pointerEvents = "none";
  preview.style.width = `${sourceRect.width}px`;
  document.body.append(preview);

  dataTransfer.setDragImage(
    preview,
    Math.max(0, Math.min(clientX - sourceRect.left, sourceRect.width)),
    Math.max(0, Math.min(clientY - sourceRect.top, sourceRect.height)),
  );

  return () => preview.remove();
}

export { createTaskWorkbenchDragPreview };
