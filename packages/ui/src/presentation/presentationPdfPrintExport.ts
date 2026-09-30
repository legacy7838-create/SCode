import type {
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";

export interface PresentationPrintHost {
  dispose(): void;
}

const HOST_ATTRIBUTE = "data-zcode-pptx-print-host";
const PAGE_ATTRIBUTE = "data-zcode-pptx-print-page";
const STYLE_ATTRIBUTE = "data-zcode-pptx-print-style";

/**
 * A single-image decode failure does not block the export (the preview would fail too), and the
 * overall decode wait is capped
 */
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

type PrintableFontScript = "latin" | "cjk" | "symbol";
type PrintableFontAvailability = (family: string, script: PrintableFontScript) => boolean;

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "emoji",
  "math",
  "fangsong",
]);

const FONT_DETECTION_SAMPLES: Record<PrintableFontScript, string> = {
  latin: "mmmmmmmmmwwwwwwwiiiiiiiii 0123456789 ABCDEFG",
  cjk: "Kanji typesetting test かなカナ한글kanji",
  symbol: "◆▶▥✦★☻♪—“”",
};

// Skia/PDF m146 PingFang can be used for screen drawing on macOS, but the corresponding glyph run will not be written to PDF.
const PRINT_UNSAFE_FONT_FAMILIES = new Set(["pingfang sc"]);

const CJK_SANS_FALLBACKS = [
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Arial Unicode MS",
  "sans-serif",
];
const CJK_SERIF_FALLBACKS = [
  "Songti SC",
  "STSong",
  "SimSun",
  "Noto Serif CJK SC",
  "Source Han Serif SC",
  "serif",
];
const LATIN_SANS_FALLBACKS = ["Arial", "Helvetica", "system-ui", "sans-serif"];
const LATIN_NARROW_FALLBACKS = ["Arial Narrow", "Arial", "Helvetica", "sans-serif"];
const LATIN_SERIF_FALLBACKS = ["Times New Roman", "Times", "Georgia", "serif"];
const MONOSPACE_FALLBACKS = ["Courier New", "Menlo", "Consolas", "monospace"];
const SYMBOL_FALLBACKS = [
  "Apple Symbols",
  "Segoe UI Symbol",
  "Noto Sans Symbols 2",
  "Arial Unicode MS",
  "sans-serif",
];

function normalizeFontFamily(family: string): string {
  return family
    .trim()
    .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")
    .trim();
}

function parseFontFamilies(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const pushCurrent = () => {
    const family = normalizeFontFamily(current);
    if (family) {
      families.push(family);
    }
    current = "";
  };

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      pushCurrent();
      continue;
    }
    current += character;
  }
  pushCurrent();
  return families;
}

function formatFontFamily(family: string): string {
  const normalized = normalizeFontFamily(family);
  if (GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())) {
    return normalized.toLowerCase();
  }
  return /[\s,"']/.test(normalized)
    ? `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : normalized;
}

function detectFontScript(text: string): PrintableFontScript {
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)) {
    return "cjk";
  }
  return /[\p{L}\p{N}]/u.test(text) ? "latin" : "symbol";
}

function isGenericFontFamily(family: string): boolean {
  return GENERIC_FONT_FAMILIES.has(normalizeFontFamily(family).toLowerCase());
}

function isKnownPrintUnsafeFontFamily(family: string): boolean {
  return PRINT_UNSAFE_FONT_FAMILIES.has(normalizeFontFamily(family).toLowerCase());
}

function classifyFontFamily(families: readonly string[]): "sans" | "narrow" | "serif" | "mono" {
  const joined = families.join(" ").toLowerCase();
  if (/mono|courier|consolas|menlo/.test(joined)) {
    return "mono";
  }
  if (/narrow|condensed|oswald|bebas/.test(joined)) {
    return "narrow";
  }
  if (
    !/sans/.test(joined) &&
    /serif|times|georgia|song|simsun|Songti|ming|mincho|playfair/.test(joined)
  ) {
    return "serif";
  }
  return "sans";
}

function getFallbackFamilies(
  script: PrintableFontScript,
  category: ReturnType<typeof classifyFontFamily>,
): readonly string[] {
  if (script === "symbol") {
    return SYMBOL_FALLBACKS;
  }
  if (script === "cjk") {
    return category === "serif" ? CJK_SERIF_FALLBACKS : CJK_SANS_FALLBACKS;
  }
  if (category === "mono") {
    return MONOSPACE_FALLBACKS;
  }
  if (category === "serif") {
    return LATIN_SERIF_FALLBACKS;
  }
  return category === "narrow" ? LATIN_NARROW_FALLBACKS : LATIN_SANS_FALLBACKS;
}

function appendGenericFallback(
  families: readonly string[],
  category: ReturnType<typeof classifyFontFamily>,
): string[] {
  if (families.some(isGenericFontFamily)) {
    return [...families];
  }
  return [
    ...families,
    category === "mono" ? "monospace" : category === "serif" ? "serif" : "sans-serif",
  ];
}

/**
 * Returns the deterministic font stack that has to be written into the print DOM; null means the
 * originally preferred font is already available and nothing needs changing.
 */
function resolvePrintableFontFamily(
  fontFamily: string,
  text: string,
  isFontAvailable: PrintableFontAvailability,
): string | null {
  const families = parseFontFamilies(fontFamily);
  if (families.length === 0) {
    return null;
  }
  const script = detectFontScript(text);
  const category = classifyFontFamily(families);
  const isAvailable = (family: string) =>
    isGenericFontFamily(family) ||
    (!isKnownPrintUnsafeFontFamily(family) && isFontAvailable(family, script));

  if (isAvailable(families[0]!)) {
    return null;
  }
  const availableIndex = families.findIndex(isAvailable);
  if (availableIndex >= 0) {
    return appendGenericFallback(families.slice(availableIndex), category)
      .map(formatFontFamily)
      .join(", ");
  }

  const fallbacks = getFallbackFamilies(script, category);
  const fallbackIndex = fallbacks.findIndex(isAvailable);
  const selected = fallbackIndex >= 0 ? fallbacks.slice(fallbackIndex) : fallbacks.slice(-1);
  return selected.map(formatFontFamily).join(", ");
}

function createCanvasFontAvailability(hostDocument: Document): PrintableFontAvailability {
  if (typeof hostDocument.defaultView?.CanvasRenderingContext2D !== "function") {
    return () => false;
  }
  const canvas = hostDocument.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return () => false;
  }
  const isMacOS = /Mac/i.test(hostDocument.defaultView?.navigator.platform ?? "");
  const macOSSubstitutedWindowsFonts = new Set([
    "microsoft yahei",
    "microsoft yahei ui",
    "Microsoft Yahei",
    "dengxian",
    "isoline",
    "simhei",
    "heiti",
    "heiti sc",
  ]);
  const cache = new Map<string, boolean>();
  return (family, script) => {
    // CoreText will replace uninstalled Windows CJK family aliases with macOS fonts, which cannot be distinguished by Canvas width;
    // Continuing to retain the original family will cause Skia printing to lose words again, so macOS directly hands it over to the printable CJK fallback.
    if (isMacOS && macOSSubstitutedWindowsFonts.has(normalizeFontFamily(family).toLowerCase())) {
      return false;
    }
    // When the CJK font is missing, the browser will continue to fall to another CJK system font; using CJK sample text width will implicitly fall back this time
    // It was mistakenly determined that the candidate font was installed. Common CJK fonts contain Latin glyphs, and Latin samples can be used to identify specific families.
    const detectionScript = script === "cjk" ? "latin" : script;
    const key = `${family}\u0000${detectionScript}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const sample = FONT_DETECTION_SAMPLES[detectionScript];
    const candidate = formatFontFamily(family);
    const available = ["monospace", "serif", "sans-serif"].some((baseline) => {
      context.font = `72px ${baseline}`;
      const baselineWidth = context.measureText(sample).width;
      context.font = `72px ${candidate}, ${baseline}`;
      return Math.abs(context.measureText(sample).width - baselineWidth) > 0.01;
    });
    cache.set(key, available);
    return available;
  };
}

/**
 * The on-screen preview lets an uninstalled font go through the implicit fallback, but
 * Chromium/Skia printing does not reliably keep that fallback layer, so the corresponding text is
 * not written into the PDF. Only the one-shot print DOM is changed here, promoting the genuinely
 * available font to the head of the font stack.
 */
function materializePrintableFontFamilies(
  hostDocument: Document,
  host: HTMLElement,
  isFontAvailable: PrintableFontAvailability = createCanvasFontAvailability(hostDocument),
): void {
  const showText = hostDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = hostDocument.createTreeWalker(host, showText);
  const textByParent = new Map<HTMLElement, string>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const parent = node.parentElement;
    if (!text || !parent) {
      continue;
    }
    textByParent.set(parent, `${textByParent.get(parent) ?? ""}${text}`);
  }

  const view = hostDocument.defaultView;
  for (const [element, text] of textByParent) {
    const fontFamily = view?.getComputedStyle(element).fontFamily || element.style.fontFamily;
    if (!fontFamily) {
      continue;
    }
    const printableFontFamily = resolvePrintableFontFamily(fontFamily, text, isFontAvailable);
    if (printableFontFamily) {
      element.style.fontFamily = printableFontFamily;
    }
  }
}

function formatCssPx(value: number): string {
  return `${Number(value.toFixed(2))}px`;
}

function buildPrintCss(pageSize: { width: number; height: number }): string {
  const width = formatCssPx(pageSize.width);
  const height = formatCssPx(pageSize.height);
  // Display:none / visibility:hidden cannot be used under screen - canvas and img require real drawing to enter the printout.
  // The fixed element under print will be repeated on every page and must be reversed to static; the height:100% of html/body will stretch out the trailing blank page.
  // Slight overflow of elements inside the slide reveals native scrollbars and is drawn into the PDF, hiding them entirely.
  return `
[${HOST_ATTRIBUTE}] * {
  scrollbar-width: none;
}
[${HOST_ATTRIBUTE}] *::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
@media screen {
  [${HOST_ATTRIBUTE}] {
    position: fixed;
    top: 0;
    left: 0;
    z-index: -1;
    transform: translateX(-200vw);
    pointer-events: none;
  }
}
@media print {
  body > :not([${HOST_ATTRIBUTE}]) {
    display: none !important;
  }
  [${HOST_ATTRIBUTE}] {
    position: static !important;
    transform: none !important;
  }
  html,
  body {
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  @page {
    size: ${width} ${height};
    margin: 0;
  }
  [${PAGE_ATTRIBUTE}] {
    width: ${width};
    height: ${height};
    position: relative;
    overflow: hidden;
    break-after: page;
  }
  [${PAGE_ATTRIBUTE}]:last-child {
    break-after: auto;
  }
}
`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function waitForPrintReady(hostDocument: Document, host: HTMLElement): Promise<void> {
  // Wait for fonts after all pages are rendered to ensure that newly triggered font loads during the rendering process are included.
  await hostDocument.fonts?.ready;
  materializePrintableFontFamilies(hostDocument, host);
  // Font replacement may hit a newly registered web font; wait again before handing it over to the print pipeline.
  await hostDocument.fonts?.ready;
  const decodes = Array.from(host.querySelectorAll("img"), (image) =>
    typeof image.decode === "function" ? image.decode().catch(() => undefined) : undefined,
  ).filter((pending): pending is Promise<void> => pending !== undefined);
  if (decodes.length > 0) {
    await Promise.race([
      Promise.all(decodes),
      new Promise((resolve) => setTimeout(resolve, IMAGE_DECODE_TIMEOUT_MS)),
    ]);
  }
  // Leave a rendering window for the first frame of the canvas/chart
  await nextFrame();
  await nextFrame();
}

/**
 * Renders every page of the presentation into a hidden print container on the same page, for
 * printToPDF to emit using the print media type. The preview lazy-renders through lazySlides, so
 * every page has to be rendered in full here for the exported PDF to contain them all.
 */
export async function renderPresentationToPrintHost(
  doc: PresentationPreviewDocument,
  hostDocument: Document,
): Promise<PresentationPrintHost> {
  const style = hostDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = buildPrintCss(doc.pageSize);

  const host = hostDocument.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");

  const handles: PresentationRenderHandle[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (let index = handles.length - 1; index >= 0; index -= 1) {
      handles[index]?.dispose();
    }
    host.remove();
    style.remove();
  };

  try {
    hostDocument.head.append(style);
    hostDocument.body.append(host);
    for (let pageIndex = 0; pageIndex < doc.pageCount; pageIndex += 1) {
      const page = hostDocument.createElement("div");
      page.setAttribute(PAGE_ATTRIBUTE, "");
      host.append(page);
      const handle = doc.renderPage(pageIndex, page);
      handles.push(handle);
      // Sequential await: flatten the media decoding memory peak; when the document is disposed in the middle, an error is thrown and terminated as soon as possible
      await handle.ready;
    }
    await waitForPrintReady(hostDocument, host);
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
