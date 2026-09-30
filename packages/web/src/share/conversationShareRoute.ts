import { parseConversationShareRoute } from "./conversationSharePreviewClient.js";

export function resolveConversationShareCodeFromPath(pathname: string): string | null {
  return parseConversationShareRoute(pathname);
}

/**
 * Both the Chinese site's /cn/share and the English site's /share are share routes.
 * This only decides "is this handled by the share page"; anything with an invalid shape is left to
 * the code parser, which reports invalid_contract.
 */
export function isConversationSharePath(pathname: string): boolean {
  return (
    pathname === "/cn/share" ||
    pathname.startsWith("/cn/share/") ||
    pathname === "/share" ||
    pathname.startsWith("/share/")
  );
}
