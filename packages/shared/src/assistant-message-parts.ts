export type ZCodeAssistantMessagePart =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "thought";
      content: string;
    }
  | {
      type: "tool-call";
      toolId: string;
    };

export function appendAssistantMessagePart(
  parts: readonly ZCodeAssistantMessagePart[] | undefined,
  nextPart: ZCodeAssistantMessagePart,
) {
  const currentParts = parts ?? [];
  const lastPart = currentParts[currentParts.length - 1];

  // Both UI latestPart and third-party completion messages rely on message part boundaries.
  // Continuous text chunks must be merged into the same content/thought part, otherwise the third party will misjudge the latest text based on token boundaries.
  if (
    lastPart &&
    lastPart.type === nextPart.type &&
    (lastPart.type === "content" || lastPart.type === "thought") &&
    (nextPart.type === "content" || nextPart.type === "thought")
  ) {
    return [
      ...currentParts.slice(0, -1),
      {
        ...lastPart,
        content: lastPart.content + nextPart.content,
      },
    ];
  }

  return [...currentParts, nextPart];
}

export function getLatestAssistantContentPart(parts: readonly ZCodeAssistantMessagePart[]) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "content") {
      return part;
    }
  }
  return null;
}

export function getLatestAssistantContentText(parts: readonly ZCodeAssistantMessagePart[]) {
  return getLatestAssistantContentPart(parts)?.content ?? "";
}
