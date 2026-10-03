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
