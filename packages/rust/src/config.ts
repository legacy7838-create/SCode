/**
 * `@zcode/rust/config` — Workspace Hook trust store and the settings/hooks surface.
 *
 * Spec: `docs/specs/rust-native-config.md`.
 *
 * INVARIANT (docs/specs/rust-native-ports.md invariant 1): there is **no** JavaScript fallback in
 * this file. If the native binary cannot be loaded, `loadNative` throws an actionable error. The
 * predecessor TypeScript is deleted, not disabled — see `docs/specs/remove-wsl.md` for the same
 * discipline applied to a deleted feature.
 */
import { loadNative } from "./loader.js";

interface NativeTrustStoreRead {
  /** `"missing" | "ok" | "corrupt"`. */
  status: string;
  /** Always empty when `status === "corrupt"`. */
  digests: string[];
  corrupt: boolean;
  /** Present only when `status === "corrupt"`. */
  reason?: string;
}

interface NativeConfig {
  readWorkspaceHookTrustStore(
    content: string | null,
    workspaceIdentity: string,
  ): NativeTrustStoreRead;
  resolveWorkspaceHookTrustStorePath(home: string, storageDir: string | null): string;
  parseWorkspaceHookTrustStore(content: string): string | null;
  parseWorkspaceHookTrustStoreAsync(content: string): Promise<string | null>;
  parseSettingsContent(content: string): string;
  parseSettingsPatch(patchJson: string): string;
  buildWorkspaceHookBundleSnapshot(inputJson: string): string | null;
  projectHooksToServiceHooks(inputJson: string): string;
  hooksFromUserZCodeSource(inputJson: string): string;
  hooksFromLegacyConfig(inputJson: string): string;
  hooksToZCodeHooksEvents(hooksJson: string): string;
  resolveNextRootEnabled(existingEnabled: boolean | null, hooksJson: string): boolean | null;
  partitionWritableHooks(hooksJson: string, currentProjectConfigPath: string): string;
  resolveWorkspaceHookRuntimeRoot(rootsJson: string): string;
  buildZCodeHooksConfig(existingJson: string, enabled: boolean | null, eventsJson: string): string;
  validateWorkspaceHooksConfig(configJson: string): string;
}

function native(): NativeConfig {
  return loadNative<NativeConfig>("zcode-config");
}

/**
 * Why the store was unusable.
 *
 * A distinct value from `null`, because the three states are the whole point of this port: a
 * corrupt store must not be able to masquerade as "no grants yet". Collapsing them is exactly the
 * bug the spec was written to remove.
 */
export type TrustStoreCorruptReason = "unreadable" | "invalid-content";

export interface TrustStoreReadResult {
  /**
   * `missing` — the file does not exist, so no grant has been made. Not a fault.
   * `ok` — parsed; `digests` is this workspace's records only.
   * `corrupt` — unreadable, invalid JSON, or a schema violation. **Fail-closed.**
   */
  status: "missing" | "ok" | "corrupt";
  /**
   * The granted declaration digests for this workspace.
   *
   * Empty whenever `status !== "ok"`, and that is structural rather than a convention: the native
   * result type has no arm that carries digests alongside `corrupt`, so the caller cannot
   * accidentally read a partially-trusted set out of a broken store.
   */
  digests: Set<string>;
  /** True only for `corrupt`. Every hook is then `pending_trust` and the runtime blocks it. */
  corrupt: boolean;
  /** Present only for `corrupt`. */
  reason?: TrustStoreCorruptReason;
}

/**
 * Read the persistent workspace hook trust digests for one workspace.
 *
 * `content` is passed in rather than read here on purpose: the native boundary owns the
 * **decision** (strict parse, fail-closed classification, identity filtering) while this layer owns
 * the **transport** (which file, and what ENOENT means). That split is what makes the decision
 * testable without a filesystem, and it is the same host-policy rule `zcode-fs` §2.2 uses.
 *
 * Replaces `readPersistentWorkspaceHookTrustDigests`
 * (`packages/services/src/hooks/hooksService.ts:154-212`).
 */
export function readWorkspaceHookTrustDigests(
  content: string | null,
  workspaceIdentity: string,
): TrustStoreReadResult {
  const read = native().readWorkspaceHookTrustStore(content, workspaceIdentity);
  const corrupt = read.status === "corrupt";
  return {
    status: read.status as TrustStoreReadResult["status"],
    // A Set, because the predecessor returned one and every consumer either tests membership or
    // iterates; an array would silently change `size` semantics at the call sites.
    digests: new Set(read.digests),
    corrupt,
    ...(read.reason ? { reason: read.reason as TrustStoreCorruptReason } : {}),
  };
}

/**
 * Resolve the trust store path from `storage.dir`.
 *
 * The predecessor resolved this inline (`hooksService.ts:158-169`) and the CLI's adapters resolve
 * an equivalent path in their own copy. Moving it in means the two cannot disagree about *which
 * file* they are talking about — the failure the predecessor's own comment records as unresolved
 * duplication.
 */
export function resolveWorkspaceHookTrustStorePath(
  home: string,
  storageDir: string | null = null,
): string {
  return native().resolveWorkspaceHookTrustStorePath(home, storageDir);
}

/**
 * Validate a whole store file.
 *
 * Returns the store as JSON text, or `null` when it is invalid. The JSON is returned rather than a
 * structured object so the consumer re-parses it with the same rules instead of getting a second
 * interpretation in TypeScript — one schema, one algorithm.
 */
export function parseWorkspaceHookTrustStore(content: string): string | null {
  return native().parseWorkspaceHookTrustStore(content);
}

/**
 * Async form of {@link parseWorkspaceHookTrustStore}.
 *
 * Use this for a store with many records: the spec measured 1.11 ms for 250 records, which is over
 * the ~1 ms event-loop line, and the store is never compacted unless the user runs the CLI.
 */
export function parseWorkspaceHookTrustStoreAsync(content: string): Promise<string | null> {
  return native().parseWorkspaceHookTrustStoreAsync(content);
}

// ---------------------------------------------------------------------------
// The AppSettings schema (§3.4)
// ---------------------------------------------------------------------------

/** One `{ path, message }` validation issue; `path` is dotted, "" is `<root>`. */
export interface SettingsIssue {
  readonly path: string;
  readonly message: string;
}

export interface SettingsParseResult {
  readonly status: "ok" | "invalid-json" | "schema-invalid";
  /** The parsed settings with defaults applied; `null` unless `status` is `ok`. */
  readonly settings: Record<string, unknown> | null;
  /** The raw-value migration predicate (T33/T34); `false` unless `status` is `ok`. */
  readonly needsMigrationPersist: boolean;
  readonly issues: SettingsIssue[];
}

export type SettingsPatchParseResult =
  | { readonly ok: true; readonly patch: Record<string, unknown> }
  | { readonly ok: false; readonly issues: SettingsIssue[] };

/**
 * `appSettingsSchema` over file text: the six-step preprocess chain, the 51
 * field validators and zod-v4-identical issues, all native. Synchronous —
 * pure compute over text the caller already holds (spec §3.6).
 */
export function parseSettingsContent(content: string): SettingsParseResult {
  return JSON.parse(native().parseSettingsContent(content)) as SettingsParseResult;
}

/**
 * `appSettingsPatchSchema` over a patch object. Returns a branch instead of
 * throwing so the caller stays exception-free across the boundary.
 */
export function parseSettingsPatch(patch: unknown): SettingsPatchParseResult {
  return JSON.parse(native().parseSettingsPatch(JSON.stringify(patch))) as SettingsPatchParseResult;
}

// ---------------------------------------------------------------------------
// Workspace-hook compute (§3.3) — the host's single implementation. The four
// `shared/src/workspace-hook-*.ts` modules stay TypeScript for the renderer
// and CLI (spec §9.3); these functions are what `hooksService.ts` calls.
// ---------------------------------------------------------------------------

/** The dependency shapes are structural; the source/entry types are `@zcode/shared`'s. */
interface WorkspaceHookSourceShape {
  canonicalPath: string;
  baseDir: string;
  discoveryOrder: number;
  configFileKind: string;
  explicitProjectConfig: boolean;
  editable: boolean;
  hooks: Record<string, unknown>;
}

interface RuntimeRootShape {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WorkspaceHookBundleSnapshotShape<T> {
  schemaVersion: 1;
  workspaceIdentity: string;
  discoveredAt: string;
  sourceFiles: unknown[];
  hooks: T[];
  digestAlgorithm: string;
  bundleDigest: string;
}

/**
 * `buildWorkspaceHookBundleSnapshot` (T7/T8). The TS default
 * `new Date().toISOString()` lives here: the sync native side owns no clock
 * (spec §3.6), so `discoveredAt` is injected exactly as the predecessor read it.
 * Returns `undefined` when the source set has no hooks.
 */
export function buildWorkspaceHookBundleSnapshot<T>(input: {
  workspaceIdentity: string;
  workspacePath: string;
  sources: readonly WorkspaceHookSourceShape[];
  runtimeRoot: RuntimeRootShape;
  discoveredAt?: string;
}): WorkspaceHookBundleSnapshotShape<T> | undefined {
  const json = native().buildWorkspaceHookBundleSnapshot(
    JSON.stringify({ ...input, discoveredAt: input.discoveredAt ?? new Date().toISOString() }),
  );
  return json === null ? undefined : (JSON.parse(json) as WorkspaceHookBundleSnapshotShape<T>);
}

/**
 * `fromProjectSnapshot` (T9–T11): the trust digest set arrives as data, and a
 * missing source throws with the predecessor's provenance message.
 */
export function projectHooksToServiceHooks<T>(input: {
  sources: readonly WorkspaceHookSourceShape[];
  snapshot: WorkspaceHookBundleSnapshotShape<unknown> | undefined;
  workspaceIdentity: string;
  workspacePath: string;
  persistentTrustedDigests?: ReadonlySet<string>;
}): T[] {
  return JSON.parse(
    native().projectHooksToServiceHooks(
      JSON.stringify({
        ...input,
        snapshot: input.snapshot ?? null,
        persistentTrustedDigests: input.persistentTrustedDigests
          ? [...input.persistentTrustedDigests]
          : [],
      }),
    ),
  ) as T[];
}

/** `fromUserZCodeSource` — entries for the single user source. */
export function hooksFromUserZCodeSource<T>(input: {
  source: WorkspaceHookSourceShape;
  runtimeRoot: RuntimeRootShape;
  workspacePath: string;
  location: unknown;
}): T[] {
  return JSON.parse(
    native().hooksFromUserZCodeSource(
      JSON.stringify({
        sources: [input.source],
        runtimeRoot: input.runtimeRoot,
        workspacePath: input.workspacePath,
        location: input.location,
      }),
    ),
  ) as T[];
}

/**
 * `fromLegacyHooksConfig`. The predecessor's `isHookEvent` predicate parameter
 * is gone: it was always the same seven names, which the native side owns.
 */
export function hooksFromLegacyConfig<T>(input: { legacyConfig: unknown; location: unknown }): T[] {
  return JSON.parse(native().hooksFromLegacyConfig(JSON.stringify(input))) as T[];
}

/** `toZCodeHooksEvents` (T48–T50). */
export function hooksToZCodeHooksEvents<T>(hooks: readonly T[]): Record<string, unknown> {
  return JSON.parse(native().hooksToZCodeHooksEvents(JSON.stringify(hooks))) as Record<
    string,
    unknown
  >;
}

/**
 * `resolveNextRootEnabled` (T52/T53). The native side answers `null` where
 * the predecessor said `undefined`; mapping back keeps the caller's
 * `enabled !== undefined` gate byte-for-byte (writing `null` would be a fork).
 */
export function resolveNextRootEnabled(
  existingEnabled: boolean | undefined,
  hooks: readonly unknown[],
): boolean | undefined {
  return (
    native().resolveNextRootEnabled(existingEnabled ?? null, JSON.stringify(hooks)) ?? undefined
  );
}

/** `saveHooksImpl`'s user/project partition (T54). */
export function partitionWritableHooks<T>(
  hooks: readonly T[],
  currentProjectConfigPath: string,
): { user: T[]; project: T[] } {
  return JSON.parse(
    native().partitionWritableHooks(JSON.stringify(hooks), currentProjectConfigPath),
  ) as { user: T[]; project: T[] };
}

/** `resolveWorkspaceHookRuntimeRoot` (T55–T57): OR-enabled, last-defined wins. */
export function resolveWorkspaceHookRuntimeRoot(
  roots: readonly (Record<string, unknown> | undefined | null)[],
): RuntimeRootShape {
  return JSON.parse(
    native().resolveWorkspaceHookRuntimeRoot(JSON.stringify(roots)),
  ) as RuntimeRootShape;
}

/** `writeZCodeHooksConfig`'s merge (T51), as an object for the shared atomic write. */
export function buildZCodeHooksConfig<T>(
  existing: Record<string, unknown>,
  enabled: boolean | undefined,
  events: Record<string, unknown>,
): T {
  return JSON.parse(
    native().buildZCodeHooksConfig(
      JSON.stringify(existing),
      enabled ?? null,
      JSON.stringify(events),
    ),
  ) as T;
}

/** `workspaceHooksConfigSchema` validation (T58): `{ok}` / `{ok, issues}`. */
export function validateWorkspaceHooksConfig(
  configJson: string,
): { ok: true } | { ok: false; issues: SettingsIssue[] } {
  return JSON.parse(native().validateWorkspaceHooksConfig(configJson)) as
    | { ok: true }
    | { ok: false; issues: SettingsIssue[] };
}
