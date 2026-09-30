import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";

function resolveCitationFileName(path: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * The image syntax `![alt](dest ...)`. `dest` allows `<...>` wrapping (it may contain spaces) or a
 * bare URL; a trailing optional title is preserved as-is —— only the leading `!` is stripped, no
 * other byte is touched.
 */
const markdownImagePattern = /!(\[[^\]]*\]\((?:<[^>\n]*>|[^)\s]*)(?:[^)\n]*)\))/gu;

/**
 * Image addresses that make a visitor's browser issue a request to a third party: absolute http(s)
 * and protocol-relative `//host`.
 */
function isRemoteImageDestination(destination: string): boolean {
  const trimmed = destination.trim().replace(/^<|>$/gu, "");
  return /^(?:https?:)?\/\//iu.test(trimmed);
}

function readImageDestination(imageSyntax: string): string {
  // imageSyntax is in the form of `[alt](dest "title")`, taking the part between the first `(` and the first blank/end.
  const open = imageSyntax.indexOf("(");
  const inner = imageSyntax.slice(open + 1, -1);
  if (inner.startsWith("<")) return inner.slice(0, inner.indexOf(">") + 1);
  const whitespace = inner.search(/\s/u);
  return whitespace < 0 ? inner : inner.slice(0, whitespace);
}

/**
 * Degrades remote images to plain links.
 *
 * The public share page (ConversationShareReadonlyTimeline) passes no workspacePath / sessionId /
 * readAttachment, so MarkdownImage falls back to `displaySrc = resolvedSrc` and renders `<img
 * src={remote} loading="lazy">`; as soon as any anonymous visitor opens the page they automatically
 * issue a request to the third party the publisher named, leaking IP / UA / Referer —— equivalent
 * to a publisher-controlled tracking pixel. This version of streamdown has no allowedImagePrefixes
 * available (linkSafety is also off), so the stripping happens at the only public-projection choke
 * point: `![alt](url)` → `[alt](url)`, which sends no automatic request, loses no information,
 * loads only on a visitor's click, and takes effect immediately even for already-published older
 * shares. Only http(s) and protocol-relative addresses are handled: `data:` does not go over the
 * network, and relative paths land on their own origin.
 */
function degradeRemoteImages(
  markdown: string,
  protectedRanges: readonly AssistantTextRange[],
): string {
  const matches = [...markdown.matchAll(markdownImagePattern)].filter(
    (match) =>
      !overlapsAssistantTextRanges(match.index, match.index + match[0].length, protectedRanges) &&
      isRemoteImageDestination(readImageDestination(match[1]!)),
  );
  let result = markdown;
  // Replace from back to front to prevent previous rewrites from invalidating subsequent indexes.
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.index)}${match[1]!}${result.slice(match.index + match[0].length)}`;
  }
  return result;
}

/**
 * The share body must not hand a local citation directive straight to MessageResponse: it would
 * both expose the path and, where workspace authority exists, be interpreted as a file operation.
 * The public projection only keeps the uniquely matching artifact display name; protocol examples
 * inside code blocks are protected by the directive parser and stay verbatim.
 *
 * It also strips the automatic loading of remote images, see degradeRemoteImages.
 */
export function normalizeConversationShareMarkdown(
  markdown: string,
  artifactNames: ReadonlyMap<string, string> = new Map(),
): string {
  const protectedRanges = findMarkdownCodeRanges(markdown);
  const directives = extractZCodeFileCitationDirectives(markdown).filter(
    (directive) => !overlapsAssistantTextRanges(directive.start, directive.end, protectedRanges),
  );

  let result = markdown;
  for (const directive of [...directives].reverse()) {
    const fileName = directive.path ? resolveCitationFileName(directive.path) : "";
    const candidates = [...artifactNames.values()].filter(
      (displayName) => displayName.trim().toLowerCase() === fileName.toLowerCase(),
    );
    const replacement = candidates.length === 1 ? candidates[0]!.trim() : "";
    result = `${result.slice(0, directive.start)}${replacement}${result.slice(directive.end)}`;
  }
  // Citation stripping will only shorten the text and will not produce new image syntax, but the code fence range may be shifted to the left.
  // Therefore, the protection area is calculated again for the rewritten text, and then the image is downgraded.
  return degradeRemoteImages(result, findMarkdownCodeRanges(result));
}
