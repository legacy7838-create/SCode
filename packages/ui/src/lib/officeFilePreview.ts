export type OfficeFilePreviewKind = "excel" | "docx" | "doc";

export interface DocxPreviewFit {
  scale: number;
  width: number;
  height: number;
}

const EXCEL_FILE_EXTENSIONS = [".xlsx", ".xlsm", ".xls"] as const;
const DOCX_FILE_EXTENSIONS = [".docx"] as const;
const LEGACY_DOC_FILE_EXTENSIONS = [".doc"] as const;

export function getOfficeFilePreviewKind(path?: string): OfficeFilePreviewKind | null {
  if (!path) {
    return null;
  }

  const normalizedPath = path.trim().toLowerCase();
  if (DOCX_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "docx";
  }
  if (LEGACY_DOC_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "doc";
  }
  if (EXCEL_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension))) {
    return "excel";
  }
  return null;
}

export function calculateDocxPreviewFit({
  availableWidth,
  naturalHeight,
  naturalWidth,
}: {
  availableWidth: number;
  naturalHeight: number;
  naturalWidth: number;
}): DocxPreviewFit | null {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(naturalWidth) ||
    availableWidth <= 0 ||
    naturalHeight <= 0 ||
    naturalWidth <= 0
  ) {
    return null;
  }

  const scale = Math.min(1, availableWidth / naturalWidth);
  return {
    scale,
    width: naturalWidth * scale,
    height: naturalHeight * scale,
  };
}

export function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * The document content comes from untrusted OOXML relationships, so the Target must not be handed
 * to the DOM as-is. Only ordinary web links and in-document anchors of the current document are
 * allowed; every other protocol is downgraded to non-clickable text.
 */
export function sanitizeDocumentHref(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const href = value.trim();
  if (!href) {
    return null;
  }

  // Control characters can disguise `java\nscript:` as a seemingly ordinary protocol; reject it instead of trying to fix it.
  // Character-by-character judgment avoids the safety regularity itself from triggering lint's no-control-regex warning.
  for (const character of href) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return null;
    }
  }

  if (href.startsWith("#")) {
    return href.length > 1 && !/[\s<>"']/u.test(href) ? href : null;
  }

  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return null;
  }

  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * A second hardening pass once the renderer has written to the DOM, covering the HTML/SVG
 * hyperlinks the parser produces.
 */
const DOCUMENT_LINK_SELECTOR = "a[href], a[xlink\\:href]";

function sanitizeDocumentLinkElement(element: Element): void {
  for (const attribute of ["href", "xlink:href"] as const) {
    const value = element.getAttribute(attribute);
    if (value === null) {
      continue;
    }

    const safeHref = sanitizeDocumentHref(value);
    if (safeHref === null) {
      element.removeAttribute(attribute);
      if (element instanceof HTMLElement && element.tagName === "A") {
        element.setAttribute("aria-disabled", "true");
      }
      continue;
    }

    if (safeHref !== value) {
      element.setAttribute(attribute, safeHref);
    }
  }
}

function sanitizeDocumentLinks(root: ParentNode): void {
  if (root instanceof Element && root.matches(DOCUMENT_LINK_SELECTOR)) {
    sanitizeDocumentLinkElement(root);
  }
  root.querySelectorAll(DOCUMENT_LINK_SELECTOR).forEach(sanitizeDocumentLinkElement);
}

/**
 * Installs uniform DOM sanitization and click blocking for each Office renderer; returns an
 * uninstall function.
 */
export function installDocumentLinkSafety(
  root: HTMLElement,
  onOpenBrowserUrl?: (url: string) => void,
): () => void {
  const handleClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target) {
      return;
    }

    const safeHref = sanitizeDocumentHref(
      target.getAttribute("href") ?? target.getAttribute("xlink:href"),
    );
    if (safeHref === null) {
      event.preventDefault();
      return;
    }
    if (safeHref.startsWith("#")) {
      return;
    }

    // Document external links cannot directly navigate the main renderer; they are handed over to the controlled Browser/external browser entrance.
    event.preventDefault();
    onOpenBrowserUrl?.(safeHref);
  };

  sanitizeDocumentLinks(root);
  root.addEventListener("click", handleClick);
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const addedRoots = new Set<ParentNode>();
          for (const record of records) {
            if (record.type === "attributes" && record.target instanceof Element) {
              sanitizeDocumentLinkElement(record.target);
              continue;
            }
            for (const addedNode of record.addedNodes) {
              if (addedNode instanceof Element || addedNode instanceof DocumentFragment) {
                addedRoots.add(addedNode);
              }
            }
          }
          // When the third-party renderer is mounted in batches or virtualized remounting, each batch of mutations is scanned
          // Full preview of the DOM, resulting in repeated O(whole-tree) queries for large documents. Only the actual newly added subtrees are scanned here.
          addedRoots.forEach(sanitizeDocumentLinks);
        });
  observer?.observe(root, {
    attributeFilter: ["href", "xlink:href"],
    attributes: true,
    childList: true,
    subtree: true,
  });

  return () => {
    observer?.disconnect();
    root.removeEventListener("click", handleClick);
  };
}
