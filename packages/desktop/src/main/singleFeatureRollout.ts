/**
 * Generic mechanism layer for single-feature gradual rollout: TTL cache, in-flight dedupe, 3s
 * request timeout, and bounded adjudication in awaitFirstDecision. The parsing layer (each
 * feature's own resolveConfig) is injected by the caller.
 *
 * Why it was extracted: desktopContextPromptRollout and rendererActionTraceRollout share the same
 * side-channel request mechanism against /api/v1/client/configs, and only the parsing of
 * `data.configs.<key>` differs; duplicating 170 lines of mechanism code would let the
 * timeout/TTL semantics silently drift apart.
 *
 * Semantic contract (same as desktopContextPromptRollout; the CUA fail-close rollout reuses it):
 * - request failure / timeout / parse failure: keep the previous snapshot (a failure on the very
 *   first call → the initial snapshot, which defaultValue decides);
 * - the server succeeded but did not send this key: treat it as "not enabled" and overwrite the
 *   stale cache (the old enabled snapshot must not keep being reused).
 */
interface SingleFeatureRolloutConfig {
  enabled: boolean;
  configVersion?: string;
}

export interface SingleFeatureRollout<T extends SingleFeatureRolloutConfig> {
  refresh(): Promise<T>;
  getSnapshot(): T;
  /**
   * Bounded wait for a single rollout adjudication: races the server request and falls back to the
   * current snapshot on timeout.
   *
   * Why: the Host/Agent presentation surface is frozen at process start (top-level const in
   * services/node.ts + CLI --surface), while the rollout request is a side channel that does not
   * block the Host. If the first Host fork happens before the request resolves, a successful result
   * has no reachable path to take effect on the already frozen Host/Agent. This method gives a
   * "successful result" a bounded path to take effect: the caller awaits it before the first Host
   * fork and, once it has the real value, lets the spawn flow read the snapshot synchronously.
   * It is stateless itself — the first-only latch is held by the caller (desktop main).
   */
  awaitFirstDecision(timeoutMs: number): Promise<T>;
}

export interface SingleFeatureRolloutLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const SINGLE_FEATURE_REQUEST_TIMEOUT_MS = 3_000;
const SINGLE_FEATURE_CACHE_TTL_MS = 60 * 60 * 1_000;

interface CreateSingleFeatureRolloutOptions<T extends SingleFeatureRolloutConfig> {
  /** Parse the /api/v1/client/configs response body; null means the response is invalid (processed as a failure and the old snapshot will be used). */
  resolveConfig: (payload: unknown) => T | null;
  /** Initial snapshot (fail-open feature passes {enabled:true}, fail-close passes {enabled:false}). */
  defaultValue: T;
  /** Log prefix, such as "desktop-context-prompt" / "renderer-action-trace". */
  logTag: string;
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: SingleFeatureRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export function createSingleFeatureRollout<T extends SingleFeatureRolloutConfig>(
  options: CreateSingleFeatureRolloutOptions<T>,
): SingleFeatureRollout<T> {
  let snapshot: T = options.defaultValue;
  let snapshotExpiresAt = 0;
  let inFlight: Promise<T> | undefined;
  const timeoutMs = Math.max(options.timeoutMs ?? SINGLE_FEATURE_REQUEST_TIMEOUT_MS, 1);
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? SINGLE_FEATURE_CACHE_TTL_MS, 1);

  const refresh = (): Promise<T> => {
    if (Date.now() < snapshotExpiresAt) {
      return Promise.resolve(snapshot);
    }
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${options.logTag} config timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        });
        const payload = await Promise.race([
          options.fetchConfig(controller.signal),
          timeoutPromise,
        ]);
        const next = options.resolveConfig(payload);
        if (!next) {
          throw new Error(`${options.logTag} config is invalid`);
        }
        snapshot = next;
        snapshotExpiresAt = Date.now() + cacheTtlMs;
        options.logger.info?.(`[${options.logTag}] config refreshed`, {
          enabled: next.enabled,
          configVersion: next.configVersion,
        });
        return snapshot;
      } catch (error) {
        // Grayscale configuration is a bypass capability: server exceptions or timeouts cannot block the client; it is used when there is a successful result, and falls back to the default after the first failure.
        options.logger.warn(`[${options.logTag}] config unavailable, using cached decision`, {
          error,
          enabled: snapshot.enabled,
        });
        return snapshot;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        controller.abort();
      }
    })();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
    );
    return request;
  };

  return {
    refresh,
    getSnapshot: () => snapshot,
    awaitFirstDecision: (timeoutMs: number) => {
      // Race with refresh(): refresh already has TTL/inFlight deduplication + 3s request timeout, and will never reject
      // (Return to the last snapshot in case of exception); when the outer timeout reaches the point, the current snapshot will be rolled back. Both of them resolve,
      // It is guaranteed that the caller (the first Host fork path) will never be blocked by reject.
      const boundedTimeout = Math.max(timeoutMs, 1);
      const fallback = new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(snapshot), boundedTimeout);
        // The bypass timer does not prevent the process from exiting (test/shutdown scenario).
        timer.unref?.();
      });
      return Promise.race([refresh(), fallback]);
    },
  };
}
