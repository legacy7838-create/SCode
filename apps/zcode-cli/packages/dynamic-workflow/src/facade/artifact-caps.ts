/**
 * The upper-bound constants of artifacts.
 *
 * ⚠ Terminology: the artifact here is a **user-facing artifact** -- the files / markdown / preset boards a script publishes to the user
 * through `artifact.*`, not the engine-internal artifact (`RunSettlement.artifact`, the typed output value in
 * `analysis/artifact-types.ts`, which is the top-level return value shown to the model).
 *
 * Just like `report-caps.ts` / `world-read-caps.ts` it forms a module of its own, for the same reason: the **enforcement side of these
 * numbers is split** -- the id count and the version count are enforced by the engine core (only it knows how many versions of an id the journal already has),
 * while the byte size and the text length are enforced by the driver (only it can read the file and write into the store). Putting them in a module on either side would make
 * readers think they are enforced by the same side; and that the numbers are the contract holds on both sides, so they must live in the pure package, with a name, so that
 * the engine tests and the driver tests assert one and the same set of constants instead of each copying its own.
 *
 * The overflow policy **splits by member family** (error code): the content members (`file` / `markdown`) return a
 * promise, so a script has somewhere to catch, and exceeding the limit is a **node-level rejection** (`ArtifactTooLarge` /
 * `ArtifactVersionCapExceeded` / `ArtifactCapExceeded`); the preset members return void and have no rejection channel,
 * so the very same limit is a failRun for that family. The boundary against world-read / report rests on the same argument.
 */

/** The count, size and text upper bounds of an artifact. The numbers are the contract (see the top of this module). */
export const ARTIFACT_CAPS = {
  /** The maximum number of distinct artifact ids within one run. */
  maxArtifactsPerRun: 32,
  /** The maximum number of versions a single id may publish (each successful publish of a content member = one version). */
  maxVersionsPerArtifact: 16,
  /** The maximum byte size of `artifact.file` (same value as PROTOCOL_V4_LIMITS.attachmentMaxBytes). */
  maxFileBytes: 20 * 1024 * 1024,
  /** The maximum byte size of `artifact.markdown` (UTF-8). */
  maxMarkdownBytes: 256 * 1024,
  /** The maximum number of characters of `opts.title`. */
  maxTitleLength: 120,
  /** The maximum number of characters of `opts.description`. */
  maxDescriptionLength: 500,
  /** The maximum byte size of a preset spec after JSON normalization. */
  maxSpecSerializedBytes: 8 * 1024,
  /** The maximum number of characters of an artifact id. */
  maxIdLength: 64,
} as const;

/**
 * The character set of a legal artifact id: `[A-Za-z0-9_.-]`, non-empty.
 *
 * Why so narrow: the id is a **cross-surface identity** -- the `dwf_node.artifact_id` column of the journal, the
 * `toolCallId` of the store, the params of a v4 query and the key of a side-panel tab all use it as a key. A slash, a space or a percent sign would turn into an escaping dispute at any one of
 * those places, and an escaping dispute solved once in each of the four places yields four answers.
 *
 * No `g` flag: a regex with `g` keeps `lastIndex` between `test` calls, so testing the same id twice gives different answers.
 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
