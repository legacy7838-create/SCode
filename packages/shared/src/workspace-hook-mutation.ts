import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { WorkspaceHookBundleSnapshotData } from "./workspace-hook-digest.js";
import { createWorkspaceHookDeclarationDigest } from "./workspace-hook-digest.js";
import {
  workspaceHooksConfigSchema,
  type WorkspaceHookDefinition,
} from "./workspace-hook-config.js";

export interface AtomicWorkspaceHookConfigWriteOptions {
  beforeRename?: () => void | Promise<void>;
}

export class WorkspaceHookMutationError extends Error {
  constructor(
    readonly code:
      | "workspace_hooks_snapshot_mismatch"
      | "workspace_hooks_bundle_changed"
      | "workspace_hooks_config_unreadable"
      | "workspace_hooks_config_write_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceHookMutationError";
  }
}

/**
 * Workspace Hook settings writes must never expose a partially-written config to Runtime watchers.
 * The temp file is written in the destination directory, flushed, closed, then atomically renamed.
 */
export async function atomicWriteWorkspaceHookConfig(
  filePath: string,
  value: Record<string, unknown>,
  options: AtomicWorkspaceHookConfigWriteOptions = {},
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.();
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeWorkspaceHookConfiguredToggle(input: {
  configPath: string;
  snapshot: WorkspaceHookBundleSnapshotData;
  reviewItemId: string;
  enabled: boolean;
  writeOptions?: AtomicWorkspaceHookConfigWriteOptions;
}): Promise<void> {
  const configPath = resolve(input.configPath);
  const entry = input.snapshot.hooks.find((item) => item.reviewItemId === input.reviewItemId);
  const source = entry ? input.snapshot.sourceFiles[entry.sourceFileIndex] : undefined;
  if (
    !entry ||
    !entry.editable ||
    !source?.editable ||
    source.configFileKind !== ".zcode/config.json" ||
    resolve(source.canonicalPath) !== configPath
  ) {
    throw mismatch("Workspace Hook toggle target is not the current editable project config");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    // Here is the failure of readFile/JSON.parse and cannot be reported as config_write_failed:
    // The user repeatedly retried "write" based on this, but the real reason was that the configuration could not be read or was not legal JSON.
    throw new WorkspaceHookMutationError(
      "workspace_hooks_config_unreadable",
      "Workspace Hook config could not be read",
      { cause: error },
    );
  }
  if (!isRecord(raw)) throw mismatch("Workspace Hook config root is not an object");
  const parsedHooks = workspaceHooksConfigSchema.safeParse(raw.hooks);
  if (!parsedHooks.success) throw mismatch("Workspace Hook config no longer matches its schema");

  const rawHooks = raw.hooks;
  if (!isRecord(rawHooks)) throw mismatch("Workspace Hook config has no hooks object");
  const events = rawHooks.events;
  if (!isRecord(events)) throw mismatch("Workspace Hook config has no events object");
  const matchers = events[entry.event];
  if (!Array.isArray(matchers)) throw mismatch("Workspace Hook event no longer exists");
  const matcher = matchers[entry.matcherIndex];
  if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) {
    throw mismatch("Workspace Hook matcher no longer exists");
  }
  const rawDeclaration = matcher.hooks[entry.hookIndex];
  if (!isRecord(rawDeclaration)) throw mismatch("Workspace Hook declaration no longer exists");
  const parsedDeclaration = getParsedDeclaration(
    parsedHooks.data.events?.[entry.event]?.[entry.matcherIndex]?.hooks[entry.hookIndex],
  );
  if (!parsedDeclaration) throw mismatch("Workspace Hook declaration no longer matches its schema");

  // Here, the entry's own resolvedTimeoutMs / resolvedMaxOutputBytes is deliberately backfilled to digest's
  // "default", the purpose is to verify that "the statement on disk is consistent with what is seen during review" - that is, source/command/event/
  // Statement ontology fields such as matcher/hookIndex have not been changed by third parties after review.
  // Known Boundary: When only the root-level defaults (hooks.timeoutMs / hooks.maxOutputBytes) change on disk,
  // entry.resolvedTimeoutMs is still the old value parsed during review, and the digest recalculated after backfilling must be equal to
  // entry.hookDeclarationDigest, so this guard will not capture changes to root default (although
  // resolvedTimeoutMs participates in digest precisely so that root changes can trigger "declaration change→re-review").
  // The admission side is not affected: hook execution evaluation uses the current snapshot and does not rely on the digest comparison here.
  // There is no risk of privilege escalation.
  const currentDigest = createWorkspaceHookDeclarationDigest({
    sourceRelativePath: entry.sourceRelativePath,
    sourceDiscoveryOrder: source.discoveryOrder,
    event: entry.event,
    matcher: parsedHooks.data.events?.[entry.event]?.[entry.matcherIndex]?.matcher ?? null,
    matcherIndex: entry.matcherIndex,
    hookIndex: entry.hookIndex,
    hook: parsedDeclaration,
    defaultTimeoutMs: entry.resolvedTimeoutMs,
    resolvedMaxOutputBytes: entry.resolvedMaxOutputBytes,
  });
  if (currentDigest !== entry.hookDeclarationDigest) {
    throw mismatch("Workspace Hook declaration changed after review");
  }

  rawDeclaration.enabled = input.enabled;
  await atomicWriteWorkspaceHookConfig(configPath, raw, input.writeOptions);
}

function getParsedDeclaration(value: unknown): WorkspaceHookDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as WorkspaceHookDefinition;
}

function mismatch(message: string): WorkspaceHookMutationError {
  return new WorkspaceHookMutationError("workspace_hooks_snapshot_mismatch", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
