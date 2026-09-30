import type { Plugin } from "unified";

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
}

// Absolute drive letter path and UNC. Only when they are hit will the original text slice be returned, and ordinary URLs will not enter the rewriting surface of this plug-in at all.
// UNC only requires a single leading backslash here: `\\` in `\\host` in the source code itself is a punctuation escape,
// After parsing, there is only one backslash left. Requiring two will miss all the UNCs that really need to be restored.
const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

// CommonMark: `\X` in the link target only produces X if X is ASCII punctuation, and leaves the rest intact.
// The four intervals are !-/, :-@, [-`, {-~, which together are exactly all ASCII punctuation marks.
const punctuationEscapePattern = /\\([!-/:-@[-`{-~])/gu;

function unescapeCommonMarkPunctuation(raw: string): string {
  return raw.replace(punctuationEscapePattern, "$1");
}

/**
 * Cut out the original text of destination according to the node shape.
 *
 * - Inline `link` / `image`: `[label](dest)` / `![alt](dest)`, take the fragment before the closing `)`.
 *   Windows paths do not contain `](`, so it is safe to take the last delimiter within the gate; this way label/alt
 *   Internal square brackets also don't bias the slice.
 * - `definition`: `[ref]: dest`, take the fragment after `]:`. The URL of the reference link is defined by
 *   Provided, the same escape loss is also true here and must be restored together.
 */
function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    return marker < 0 ? null : slice.slice(marker + 2).trim();
  }

  if (!slice.endsWith(")")) return null;
  const marker = slice.lastIndexOf("](");
  return marker < 0 ? null : slice.slice(marker + 2, -1).trim();
}

/**
 * Retrieve the unescaped destination text of the node from the VFile text.
 *
 * `[x](C:\Users\developer\.zcode\a.png)` will convert `\.` during the remark-parse stage
 * Eat it as punctuation escape (`\U` `\z` `\w` these survive because they are not followed by punctuation), obtained by mdast
 * is `C:\Users\developer.zcode\a.png`. The loss occurs in the parsing phase and the existing rewritten plug-in in the rehype phase.
 * What you see is the lost string, which cannot be restored - so it must be done in the remark stage.
 *
 * Only if "the original text is exactly equal to node.url after being de-escaped according to CommonMark rules" will the slice be considered correct and restored.
 * Unambiguous; otherwise prefer to keep the status quo and not write a potentially wrong path.
 */
function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  // The link with title needs to parse the quotation mark syntax to locate the end of destination. If you cut it wrong, the quotation marks will be included.
  // Path; if this scene does not appear, just give up restoring.
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  // The angle bracket form has different escaping rules than the bare form, and is also treated as non-reduction.
  if (raw === null || !raw || raw.startsWith("<") || raw === url) return null;
  if (unescapeCommonMarkPunctuation(raw) !== url) return null;

  return raw;
}

export const windowsFileLinkEscapeRemarkPlugin: Plugin =
  function windowsFileLinkEscapeRemarkPlugin() {
    return (tree: unknown, file: unknown) => {
      const source = String(file ?? "");
      if (!source) return;

      const visit = (node: MarkdownNode): void => {
        if (node.type === "link" || node.type === "image" || node.type === "definition") {
          const raw = recoverRawDestination(node, source);
          if (raw !== null) node.url = raw;
        }

        node.children?.forEach(visit);
      };

      visit(tree as MarkdownNode);
    };
  };
