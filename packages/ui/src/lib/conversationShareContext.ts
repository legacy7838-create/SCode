const SHARE_CONTEXT_BLOCK_PATTERN =
  /(?:\n\n)?# zcode-share-context:\n```zcode-share-context\n([\s\S]*?)\n```\s*$/u;

interface ConversationShareContextReference {
  contextId: string;
  shareUrl: string;
}

/**
 * Extracts the share handover context that is still attachable from the session snapshot.
 *
 * Deliberately reads only the snapshot (no separate parameter): this line broke once — the composer
 * used to read a parallel `sharedContextImport` prop that SessionPane never passed, so the first
 * message never carried sharedContextRefs, the CLI could not move through pending→reserved→attached
 * at all, and the model got no shared content (the read-only block at the top still rendered, so it
 * was invisible to the eye). The snapshot is something the composer necessarily has, so deriving
 * from it makes a missed attach impossible.
 *
 * The legacy shape (title only, no contextId) returns null: without a contextId there is no way to
 * build sharedContextRefs, so an attach is out of the question.
 */
export function resolveAttachableShareContext(
  sharedContextImport:
    | { contextId: string; title: string; shareUrl: string; status: string }
    | { title: string }
    | null
    | undefined,
): { contextId: string; title: string; shareUrl: string; status: string } | null {
  if (!sharedContextImport || !("contextId" in sharedContextImport)) return null;
  return sharedContextImport.status === "discarded" ? null : sharedContextImport;
}

function isReference(value: unknown): value is ConversationShareContextReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "contextId" && key !== "shareUrl")) return false;
  if (typeof candidate.contextId !== "string" || typeof candidate.shareUrl !== "string")
    return false;
  try {
    const url = new URL(candidate.shareUrl);
    return /^\/cn\/share\/[^/]+$/u.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Strips the trailing share URL block that historical messages may carry out of the visible body.
 *
 * That block is no longer produced: it was purely self-produced and self-consumed by the renderer
 * (there is no consumer anywhere in CLI/shared), its only job was to drive a chip that has since
 * been cut, and the price was stuffing a share URL into the body sent to the model. The writing
 * side is deleted and only the reading side is kept here, so that messages sent between the wiring
 * fix and the chip removal do not display raw markup as body text.
 */
export function parseConversationShareContext(text: string): {
  visibleContent: string;
  reference: ConversationShareContextReference | null;
} {
  const match = text.match(SHARE_CONTEXT_BLOCK_PATTERN);
  if (!match) return { visibleContent: text, reference: null };
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    return isReference(parsed)
      ? { visibleContent: text.slice(0, match.index).trimEnd(), reference: parsed }
      : { visibleContent: text, reference: null };
  } catch {
    return { visibleContent: text, reference: null };
  }
}
