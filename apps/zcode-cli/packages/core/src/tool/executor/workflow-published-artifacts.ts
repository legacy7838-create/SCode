/**
 * The one-line projection on the model surface of a workflow run's **user-facing artifacts**, shared by three call sites:
 * the `<artifacts>` section of the completion notification (background-tasks.ts), the `artifacts[]` of the manifest payload (same file), and
 * the `<artifacts>` cross-section of the `GetWorkflowRun` model text (handlers/get-workflow-run.ts).
 *
 * ⚠ Terminology: an artifact here is **what the script publishes for the user to see via `artifact.*`**
 * -- a file, a piece of markdown, or a chart / table / metrics / board fed by a `report` tag. It is **two different things** from
 * `serializeWorkflowArtifact` in the neighbouring `workflow-artifact.ts`:
 * that artifact is the script's top-level return value (the engine-internal `RunSettlement.artifact`), shown to the model.
 * Both appear side by side in the completion notification (`<result>` and `<artifacts>`), so the files are deliberately kept apart too.
 *
 * Why the one-line format is written only once: the reader of all three is the same model, and a diverging format would make it think the artifacts in the
 * notification and the artifacts in `GetWorkflowRun` are two different sets.
 */

/** Everything one artifact needs on the model surface. The three call sites have different input shapes; this structure is their intersection. */
interface PublishedArtifactSummary {
  id: string;
  kind: string;
  version: number;
  title?: string;
  contentType?: string;
  /** The byte size of the latest version of a content artifact (file / markdown). A preset dashboard has no bytes. */
  bytes?: number;
  /** The number of `report` tags a preset dashboard received (the data volume). A content artifact is always 0. */
  itemCount?: number;
  /** A run's deliverable: the list leads with it, and the row is marked `primary`. */
  primary?: true;
  /** Only the deliverable's sentence goes into the manifest: the completion card draws it as a single line of text. */
  description?: string;
}

/** The bound on the deliverable `description` in the manifest (`ARTIFACT_CAPS.maxDescriptionLength`, the same value as shared's zod). */
const WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS = 500;

/**
 * The deliverable leads, the rest keep their original order (a stable sort). All three lists pass this step before truncating, so the upper bound can never cut off the deliverable.
 * The port's `artifactsOf` has already sorted; sorting once more here serves the snapshot and notification path (they read the projection's order).
 */
function primaryFirst<T extends { primary?: true }>(artifacts: readonly T[]): T[] {
  return [...artifacts].sort(
    (left, right) => Number(right.primary === true) - Number(left.primary === true),
  );
}

/** How many rows `<artifacts>` lists at most in the completion notification. The payload bound (<= 8) and the text row count are deliberately the same value. */
export const WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES = 8;
/** The upper bound of the `<artifacts>` cross-section of `GetWorkflowRun` (a bounded 32 = the per-run cap of `ARTIFACT_CAPS`). */
export const WORKFLOW_ARTIFACTS_INTROSPECTION_MAX_LINES = 32;
/** The bound on the title in the manifest payload (`ARTIFACT_CAPS.maxTitleLength`, the same value as shared's zod). */
const WORKFLOW_ARTIFACT_TITLE_MAX_CHARS = 120;
/** The bound on the id (`ARTIFACT_CAPS.maxIdLength`, the same value as shared's zod). */
const WORKFLOW_ARTIFACT_ID_MAX_CHARS = 64;
/** The bound on contentType (the same value as shared's zod; MIME itself has no legitimate form that long). */
const WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS = 255;

/** The four members of a preset dashboard: they have no bytes, and the data volume is the number of report tags. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set(["chart", "table", "metrics", "board"]);

/**
 * One artifact -> one line: `- {id} ({kind}, v{version}, {contentType}, {bytes} bytes): {title}`.
 *
 * A missing component drops its whole segment rather than leaving an empty slot -- `(file, v2, , : )` reads like corrupted data. A preset dashboard swaps the bytes
 * for `{n} items`: the "size" of a chart is how many points it has, and a byte count is meaningless for it (it has no bytes to begin with).
 * When `title` is absent, the colon goes with it (the facade's default title is the id, and repeating it carries no information).
 *
 * Deliberately **no `uri`**: the model cannot read the tool-artifact store. To get the content, go through `GetWorkflowRun`, or have
 * the subagent read the original path in the workspace.
 */
export function formatPublishedArtifactLine(artifact: PublishedArtifactSummary): string {
  // `primary` follows the type: `- report (markdown, primary, v2, …)` - this is how the model knows which item to give to the user first.
  const parts = artifact.primary === true ? [artifact.kind, "primary"] : [artifact.kind];
  parts.push(`v${artifact.version}`);
  if (artifact.contentType !== undefined && artifact.contentType.length > 0) {
    parts.push(artifact.contentType);
  }
  if (PRESET_ARTIFACT_KINDS.has(artifact.kind)) {
    if (artifact.itemCount !== undefined) {
      parts.push(`${artifact.itemCount} item${artifact.itemCount === 1 ? "" : "s"}`);
    }
  } else if (artifact.bytes !== undefined) {
    parts.push(`${artifact.bytes} bytes`);
  }
  const head = `- ${artifact.id} (${parts.join(", ")})`;
  const title = artifact.title?.trim();
  return title === undefined || title.length === 0 ? head : `${head}: ${title}`;
}

/** The three things the `<artifacts count shown>` section needs, shaped the same as the `<reports>` section. */
interface WorkflowArtifactsNotificationSection {
  /** The **true total count** (not the number of rows listed). */
  count: number;
  /** The number of rows actually listed; smaller than count means the list is partial. */
  shown: number;
  preview: string;
}

/**
 * An artifact list -> the `<artifacts>` section of the completion notification / `GetWorkflowRun`.
 *
 * Same rule as `<reports>`: `count` is always the true total, and `count ≠ shown` is the signal "the list is partial, the full set can be fetched with the run
 * id". On an empty list it returns `undefined`, and the caller makes the whole section absent accordingly -- an empty `<artifacts>` section is never sent.
 */
export function buildWorkflowArtifactsNotificationSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
  maxLines: number,
): WorkflowArtifactsNotificationSection | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const lines = primaryFirst(artifacts).slice(0, maxLines).map(formatPublishedArtifactLine);
  return { count: artifacts.length, shown: lines.length, preview: lines.join("\n") };
}

/** One entry of the manifest payload (`WorkflowNotificationMeta.artifacts`). shared's zod enforces the same set of bounds. */
interface WorkflowArtifactManifestEntry {
  id: string;
  kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
  title?: string;
  version: number;
  contentType?: string;
  primary?: true;
  /** Only on the `primary` entry (the completion card's deliverable row speaks it; the other chips have no room for it and do not need it). */
  description?: string;
}

/**
 * The `artifacts` and `artifactsTruncated` of the manifest payload.
 *
 * **Same source, different shape** from the section above: the GUI renders each entry as a chip (an icon + a shortened title), so the payload carries
 * structured fields instead of a preassembled line; `bytes` / `itemCount` deliberately stay out of the payload -- they do not fit on a chip, and opening the side panel
 * shows all of it. Truncation happens **before construction**: the payload travels the protocol on the turnHeader row, and exceeding the bound makes zod reject the whole row when it is persisted.
 *
 * An entry whose `kind` is not among the six literals is dropped whole (no guessing, no normalizing): a chip of an unknown kind has no icon
 * to draw in the GUI, and letting it through would get the whole payload rejected by zod, taking every other chip down with it.
 *
 * On an empty list it returns `undefined`, and the caller makes both fields absent accordingly.
 */
export function buildWorkflowArtifactsManifestSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
): { artifacts: WorkflowArtifactManifestEntry[]; artifactsTruncated?: true } | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const entries: WorkflowArtifactManifestEntry[] = [];
  // Advanced list of deliverables: The upper bound of 8 will never cut it.
  for (const artifact of primaryFirst(artifacts)) {
    if (entries.length >= WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES) break;
    const kind = manifestArtifactKind(artifact.kind);
    // id is the identity key of the chip. Truncation is to make up a non-existent product - the super realm can only be lost in its entirety, which is the same as the unknown kind.
    // Both are "a bad line should not take the rest of the chip with it": passing it will cause zod to reject the entire payload.
    if (kind === undefined || artifact.id.length === 0) continue;
    if (artifact.id.length > WORKFLOW_ARTIFACT_ID_MAX_CHARS) continue;
    // The version number is one of the positioning keys of the chip. The shared zod requires a positive integer; non-positive integers are also discarded in their entirety.
    if (!Number.isInteger(artifact.version) || artifact.version < 1) continue;
    const title = artifact.title?.trim();
    // contentType is just a decoration on the chip. This is a key instead of the entire one.
    const contentType =
      artifact.contentType !== undefined &&
      artifact.contentType.length <= WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS
        ? artifact.contentType
        : undefined;
    const description = artifact.primary === true ? artifact.description?.trim() : undefined;
    entries.push({
      id: artifact.id,
      kind,
      ...(title === undefined || title.length === 0
        ? {}
        : { title: title.slice(0, WORKFLOW_ARTIFACT_TITLE_MAX_CHARS) }),
      version: artifact.version,
      ...(contentType === undefined ? {} : { contentType }),
      ...(artifact.primary === true ? { primary: true as const } : {}),
      ...(description === undefined || description.length === 0
        ? {}
        : { description: description.slice(0, WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS) }),
    });
  }
  if (entries.length === 0) return undefined;
  // Truncated honesty: what is cut off by the upper bound and what is filtered out by types are considered "there are more that have not been drawn" - the criterion is therefore
  // "The number drawn is less than the total number", not "the upper limit is hit".
  const truncated = entries.length < artifacts.length;
  return { artifacts: entries, ...(truncated ? { artifactsTruncated: true as const } : {}) };
}

const MANIFEST_ARTIFACT_KINDS: readonly WorkflowArtifactManifestEntry["kind"][] = [
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
];

function manifestArtifactKind(kind: string): WorkflowArtifactManifestEntry["kind"] | undefined {
  return MANIFEST_ARTIFACT_KINDS.find((known) => known === kind);
}

/**
 * Artifacts on a snapshot / the port's detail view -> the input shape of this module. `bytes` exists only on the version entries (the port's top level deliberately does not carry it),
 * so it is taken from the **latest version** -- which is exactly the version the list is meant to describe.
 *
 * The shape is defensively checked all the same: the input crosses package boundaries (a port implementation, or a row coming back from cold recovery), and one bad entry should not make the whole
 * section vanish. A non-conforming entry is skipped whole.
 */
export function toPublishedArtifactSummaries(
  value: unknown,
): PublishedArtifactSummary[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const summaries: PublishedArtifactSummary[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const version = typeof record.version === "number" ? record.version : undefined;
    if (id === undefined || kind === undefined || version === undefined) continue;
    const versions = Array.isArray(record.versions) ? record.versions : undefined;
    const latest = versions?.[versions.length - 1];
    const bytes =
      latest !== null &&
      typeof latest === "object" &&
      typeof (latest as Record<string, unknown>).bytes === "number"
        ? ((latest as Record<string, unknown>).bytes as number)
        : undefined;
    summaries.push({
      id,
      kind,
      version,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.contentType === "string" ? { contentType: record.contentType } : {}),
      ...(bytes === undefined ? {} : { bytes }),
      ...(typeof record.itemCount === "number" ? { itemCount: record.itemCount } : {}),
      ...(record.primary === true ? { primary: true as const } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    });
  }
  return summaries.length === 0 ? undefined : summaries;
}
