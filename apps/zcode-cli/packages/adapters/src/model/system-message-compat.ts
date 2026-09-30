import {
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly ModelInputMessage[],
): ModelInputMessage[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") {
    leadingSystemCount += 1;
  }

  if (leadingSystemCount <= 1) {
    return [...messages];
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);

  // Some legacy OpenAI-compatible chat templates only accept a starting name of system.
  // Core intentionally reserves multiple segments for Anthropic cache boundaries, so they are only merged in original order at compatible protocol serialization boundaries.
  // ZCode by design: Each subsequent block has its own left boundary, and the adapter does not infer or fill in any blanks.
  return [
    {
      role: "system",
      content: leadingSystemMessages
        .map((message) => modelMessageContentToText(message.content))
        .join(""),
      ...(lastLeadingSystem?.cacheControl
        ? { cacheControl: { ...lastLeadingSystem.cacheControl } }
        : {}),
    },
    ...messages.slice(leadingSystemCount),
  ];
}
