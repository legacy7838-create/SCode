/**
 * The serialization rules for workflow run artifacts, shared by two places inside core: the `<result>` of the
 * completion notification (background-tasks.ts) and the `resultText` on the runtime task entry
 * (background-task-registry.ts, the only source for TaskOutput).
 *
 * The implementation was **moved to `@zcode/contracts`** (`interfaces/dynamic-workflow-run.port.ts`, the same
 * seam as `boundDynamicWorkflowRunEventPayload`) because it gained a third consumer: bootstrap's v4 projection
 * needs the same rules to compute `workflowRuns.reports[].preview` (the Results section of the detail page).
 * bootstrap cannot import core's internal modules, and duplicating the serialization rules is exactly the
 * source of "the same value looks different in the notification and on the panel". A re-export is kept here so
 * that the two import sites on the core side stay untouched.
 */
import { serializeWorkflowArtifact } from "@zcode/contracts";

export { serializeWorkflowArtifact };

/**
 * The budget of the `<reports>` section in the completion notification: at most this many characters for the
 * whole section.
 *
 * The notification side already has a 120k total truncation, but that is the **last** gate: what it cuts first
 * are the fields ordered later. Progressive artifacts can number 256, and letting them spread out would push
 * `<result>` and `<error>` out of the notification, while those two are what the model reads first.
 * So this section carries its own budget.
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** The bound for a single entry. A 32KB artifact should not eat the whole section budget and keep the next ten out too. */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** The **true total count** (not the number of entries in the preview). */
  count: number;
  /** The number of entries actually given in the preview; less than count means the preview is partial. */
  shown: number;
  preview: string;
}

/**
 * report entries from the journal -> the `<reports>` section of the completion notification (shared by
 * completed / failed / cancelled).
 *
 * Truncation and count are **both important**: it is the count that tells the main agent "the preview is
 * partial, the full set can be fetched via the run id". Preview alone would make the model think it had seen
 * everything; count alone would amount to returning no artifacts at all.
 *
 * With zero entries it returns `undefined`, and the caller then leaves the whole section absent: an empty
 * `<reports>` section is never emitted.
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // Give at least one: A very long product is more useful than "reported 11 but can't see any of them".
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return { count: items.length, shown: lines.length, preview: lines.join("\n") };
}

/**
 * The `<reports>` section of the manifest payload (`WorkflowNotificationMeta.reports`). It has the same source
 * and the same per-entry serialization as the section used for the **notification text** above
 * (`serializeWorkflowArtifact`), except that it produces a **string[]** rather than one concatenated block of
 * text: the GUI renders the manifest entry by entry into a numbered preview, and concatenating would force it
 * to split them again.
 *
 * The bound deliberately differs from the notification-text section: here each entry is ≤500 and there are at
 * most 8 entries (kept in sync with the shared `workflowNotificationMetaSchema`: going over the bound makes zod
 * reject the turnHeader row at persistence time).
 * `count` is always the **true total count**: `count ≠ shown` is the signal that "the preview is partial, the
 * full set is available via the run id".
 *
 * With zero entries it returns `undefined`, and the caller then leaves the whole field absent.
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS));
  }
  return { count: items.length, shown: preview.length, preview };
}

/** The bound for a per-entry artifact preview in the manifest payload (shared schema: ≤500 characters). */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** The maximum number of preview entries in the manifest payload (shared schema: ≤8 entries). */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

