import { z } from "zod";

export const browserElementRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type BrowserElementRect = z.infer<typeof browserElementRectSchema>;

/**
 * A snapshot entry for a single interactive element, carrying locational information via
 * role, name and ref so that we never dump the whole page DOM. `ref` is a stable
 * reference assigned in DOM order (e1, e2, ...); later actions address elements by ref.
 */
export const browserSnapshotElementSchema = z
  .object({
    ref: z.string().min(1),
    tag: z.string(),
    role: z.string().optional(),
    /** accessibleName */
    name: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    selector: z.string(),
    xpath: z.string(),
    rect: browserElementRectSchema,
    inViewport: z.boolean(),
    /** The ref of the parent interactive element (a hierarchy hint; omitted for top-level elements or when the parent is not interactive). */
    parentRef: z.string().optional(),
    /** The frame path the element originates from (annotated when a same-origin iframe is traversed, e.g. "0>2"; omitted for the main document). */
    framePath: z.string().optional(),
    /** Bounded, stable attributes used to build a locator from DOM facts; high-noise fields such as class/style/src are not returned. */
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotElement = z.infer<typeof browserSnapshotElementSchema>;

/**
 * A visible semantic DOM node. It only serves to "read the page"; actionable handles are
 * still maintained separately by elements/ref, so that body-text nodes cannot consume the
 * whole action ref budget. `ref` only exists when that semantic node is also in elements.
 */
export const browserSnapshotDomNodeSchema = z
  .object({
    tag: z.string(),
    depth: z.number().int().nonnegative(),
    inViewport: z.boolean(),
    ref: z.string().min(1).optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotDomNode = z.infer<typeof browserSnapshotDomNodeSchema>;

export const browserSnapshotSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    /**
     * A bounded visible semantic DOM; `optional` keeps protocol compatibility with older
     * backends/results. It must be defined before `elements`: Zod rebuilds the object in
     * schema order, so when a large page's tool result gets truncated the model should
     * see the page semantics first, not the action details such as selector/xpath/rect.
     */
    dom: z.array(browserSnapshotDomNodeSchema).optional(),
    /** True when the semantic DOM nodes exceed the internal budget. */
    domTruncated: z.boolean().optional(),
    elements: z.array(browserSnapshotElementSchema),
    /** Truncated when the element count exceeds maxElements. */
    truncated: z.boolean(),
  })
  .strict();
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
