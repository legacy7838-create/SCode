import type { ModelMessage as AiSdkModelMessage } from "ai";
import {
  getUnsupportedModelInputMediaKind,
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
type AiSdkUserContentParts = Extract<AiSdkUserContent, unknown[]>;

interface ToolResultMediaProjectionOptions {
  apiFormat?: string;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
  toolName: string;
}

const CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS = new Set(["openai-compatible", "gateway"]);
const TOOL_RESULT_MEDIA_INTRO_PREFIX = "Tool result media from";

export function shouldTextifyStructuredToolResults(
  options: Pick<ToolResultMediaProjectionOptions, "apiFormat" | "providerKind">,
): boolean {
  if (options.apiFormat !== undefined) {
    return options.apiFormat === "openai-chat-completions";
  }
  // Root cause: openai kind uses Responses API; judging by the broad OpenAI-like family, it
  // Mistakenly projected as tool text + synthetic user of Chat Completions. Only true when explicit format is missing
  // Provider fallback that does use Chat-style results, explicit apiFormat still has the highest priority.
  return (
    options.providerKind !== undefined &&
    CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS.has(options.providerKind)
  );
}

/**
 * Whether a tool result carries video media. The AI SDK tool result part has no video variant (beyond image-data it
 * only supports file-data/pdf), so a tool result containing video must go through textify + a trailing user part
 * projection on every provider kind (including anthropic), otherwise the video content is lost at the wire boundary.
 */
export function toolResultHasVideoMedia(content: ModelMessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "video");
}

/**
 * Pairing rule (driven by the producer predicate): a text block immediately after a media block whose content is a
 * protected media credential (an image_ref issued by the producer, say) is treated as the paired text for that media.
 * When the provider projection defers media into a separate user message (openai-like textify), the paired text must be deferred
 * along with it and keep its order — leaving it in the tool text makes the model see the "referring text" and the "referenced media"
 * living in two different messages, which mismatches easily in multi-frame scenarios.
 * Ordinary text (explanations, summaries) is not a credential and takes no part in the pairing — the media semantics of ordinary
 * tools stay unchanged; credential detection is part of the producer frame contract, which the host references via frame-contract.
 * Producer canonical order is image-first (the raster comes first, image_ref immediately after it). The pairing lookup reads an image's
 * authority backwards from the image, and does not rely on provider-specific truncation behavior.
 */
type PairedTextOptions = Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">;

function isPairedTextBlock(
  content: ModelMessageContentBlock[],
  index: number,
  options: PairedTextOptions,
): boolean {
  const block = content[index];
  if (block?.type !== "text" || block.text.trim().length === 0) return false;
  // Only media credentials issued by the producer are paired; any adjacent text pairing will change the
  // Universal media semantics (adjacent descriptions of normal screenshots/file previews are not media).
  if (!containsOfficialCuaImageRefCredentialText(block.text)) return false;
  // Skipping blank text and looking for earlier images will destroy the image -> image_ref specified by the producer
  // Direct adjacencies, and possibly reauthorizing frame_refs that have been split by the inserted block.
  const candidate = content[index - 1];
  return (
    candidate !== undefined &&
    contentBlockToUserMediaParts(candidate, {
      ...options,
      toolName: "",
    }).length > 0
  );
}

function pairedTextIndexes(
  content: ModelMessageContentBlock[],
  options: PairedTextOptions,
): Set<number> {
  // When stripMedia, media will not be delayed (toToolResultMediaUserParts directly returns empty),
  // Pairing omissions must not precede - otherwise the text disappears from the tool output and does not appear in any messages.
  if (options.stripMedia === true) return new Set();
  const paired = new Set<number>();
  for (let index = 0; index < content.length; index += 1) {
    if (isPairedTextBlock(content, index, options)) paired.add(index);
  }
  return paired;
}

export function toStructuredToolResultText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "inputFormat"> = {},
): string {
  if (typeof content === "string") return content;
  const paired = pairedTextIndexes(content, options);
  return modelMessageContentToText(
    content.map((block, index) => {
      // Paired text is deferred with media (see toToolResultMediaUserParts), omitted here
      // This prevents the model from seeing two referenced texts in the same request.
      if (paired.has(index)) return { type: "text", text: "" };
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      return unsupportedText ? { type: "text", text: unsupportedText } : block;
    }),
  );
}

export function toToolResultMediaUserParts(
  content: ModelMessageContent,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  if (typeof content === "string" || options.stripMedia) return [];
  const blocks = content;
  const paired = pairedTextIndexes(blocks, options);

  const parts: AiSdkUserContentParts = [
    {
      type: "text",
      text: `${TOOL_RESULT_MEDIA_INTRO_PREFIX} ${options.toolName}:`,
    },
  ];
  // The delimiter is only used to separate "two consecutive pieces of paired text". The original criterion is parts.length > 1, which implicitly assumes pairing
  // Text is always the first to be enqueued (old text-first layout); after producer is changed to image-first, raster
  // Enqueued first, this criterion inserts an extra empty text block between image and its image_ref.
  let lastPushedWasPairedText = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.type === "text" && paired.has(index)) {
      // Paired text goes into the deferred message with adjacent media, maintaining the original order.
      if (lastPushedWasPairedText) parts.push({ type: "text", text: "\n\n" });
      parts.push({ type: "text", text: block.text });
      lastPushedWasPairedText = true;
      continue;
    }
    const mediaParts = contentBlockToUserMediaParts(block, options);
    if (mediaParts.length === 0) continue;
    parts.push(...mediaParts);
    lastPushedWasPairedText = false;
  }
  return parts.length > 1 ? parts : [];
}

function contentBlockToUserMediaParts(
  block: ModelMessageContentBlock,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  switch (block.type) {
    case "image": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      // Consistent with the user message side: video/* The file part is handed over to the provider after patching, including video_url / video block.
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) return [];
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (!data) return [];
      return [
        {
          type: "file",
          data: data.data,
          filename: block.name,
          mediaType: block.mediaType,
        },
      ];
    }

    case "text":
    case "reasoning":
    case "resource_link":
      return [];
  }
}

/**
 * The generic fail-closed guard (a coordinate frame reference must not reach the model as "reference present, raster
 * absent"): a structured tool result carries frame reference text (such as the exact JSON of a CUA image_ref), and when
 * its media cannot be delivered (the model does not support it, or stripMedia), that result must be turned into an
 * error as a whole — placeholder substitution would leave an actionable reference behind, tempting the model to act on
 * coordinates for a picture it has never seen. The rule depends only on the structural combination of "reference text + undeliverable media" and knows nothing about the specific tool.
 */
export function undeliverableFrameReferenceText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  // Same inline scan detector as MCP normalization/hook - wrap image_ref in description text
  // Fail-closed cannot be bypassed (security boundaries do not depend on payload shape).
  const frameReferenceIndexes = content.flatMap((block, index) =>
    block.type === "text" && containsOfficialCuaImageRefCredentialText(block.text) ? [index] : [],
  );
  if (frameReferenceIndexes.length === 0) return undefined;
  const unavailable =
    "This tool returned a coordinate frame reference without a deliverable raster. " +
    "No image_ref or raster was exposed; do not use frame-bound coordinates. " +
    "Switch to an image-capable model and capture a new raster first.";
  if (options.stripMedia === true) return unavailable;
  // Each voucher must be independently satisfied for deliverability by its immediately preceding raster; other irrelevant images in the results
  // Cannot endorse orphan ref.
  return frameReferenceIndexes.every((index) => isPairedTextBlock(content, index, options))
    ? undefined
    : unavailable;
}
