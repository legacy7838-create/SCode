import { realpath as fsRealpath } from "node:fs/promises";
import { realpathSync as fsRealpathSync, statSync as fsStatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LOCAL_MEDIA_PREVIEW_SCHEME, buildLocalMediaPreviewUrl } from "@zcode/shared";

interface LocalMediaPreviewSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: { standard: boolean; secure: boolean; stream: boolean };
    }>,
  ): void;
}

interface LocalMediaPreviewProtocolRequest {
  url: string;
}

type LocalMediaPreviewProtocolResponse = string | { error: number };

interface LocalMediaPreviewProtocol {
  registerFileProtocol(
    scheme: string,
    handler: (
      request: LocalMediaPreviewProtocolRequest,
      callback: (response: LocalMediaPreviewProtocolResponse) => void,
    ) => void,
  ): boolean;
}

const installedProtocols = new WeakSet<object>();
const NET_ERR_INVALID_URL = -300;

interface LocalMediaPreviewPathRegistry {
  authorize(path: string): Promise<string>;
  isAuthorized(path: string): boolean;
  clear(): void;
}

const LOCAL_MEDIA_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
const LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES = 256;

/**
 * Main only registers the exact files that Host has already validated through
 * workspace/session/message/attachment.
 * The old protocol trusted the absolute path straight out of the renderer URL, which let any
 * renderer script read any file.
 */
export function createLocalMediaPreviewPathRegistry(
  dependencies: {
    isAbsolutePath?: (path: string) => boolean;
    realpath?: (path: string) => Promise<string>;
    realpathSync?: (path: string) => string;
    isRegularFileSync?: (path: string) => boolean;
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
): LocalMediaPreviewPathRegistry {
  const authorizedPaths = new Map<
    string,
    { canonicalPath: string; expiresAt: number; lastUsedAt: number }
  >();
  // The permanent Set will grow unbounded, and will continue to obtain file loader permissions after the path is replaced with a symlink.
  const isAbsolutePath = dependencies.isAbsolutePath ?? isAbsolute;
  const realpath = dependencies.realpath ?? fsRealpath;
  const realpathSync = dependencies.realpathSync ?? fsRealpathSync;
  const isRegularFileSync =
    dependencies.isRegularFileSync ?? ((path: string) => fsStatSync(path).isFile());
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? LOCAL_MEDIA_AUTHORIZATION_TTL_MS;
  const maxEntries = dependencies.maxEntries ?? LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES;

  const pruneExpired = (observedAt: number) => {
    for (const [path, entry] of authorizedPaths) {
      if (entry.expiresAt <= observedAt) authorizedPaths.delete(path);
    }
  };

  const evictLeastRecentlyUsed = () => {
    while (authorizedPaths.size > maxEntries) {
      let oldestPath: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [path, entry] of authorizedPaths) {
        if (entry.lastUsedAt < oldestAccess) {
          oldestAccess = entry.lastUsedAt;
          oldestPath = path;
        }
      }
      if (!oldestPath) return;
      authorizedPaths.delete(oldestPath);
    }
  };

  return {
    async authorize(path) {
      if (!isAbsolutePath(path)) {
        throw new Error("Local media preview path must be absolute");
      }
      const canonicalPath = await realpath(path);
      const observedAt = now();
      pruneExpired(observedAt);
      authorizedPaths.set(canonicalPath, {
        canonicalPath,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
      });
      evictLeastRecentlyUsed();
      return canonicalPath;
    },
    isAuthorized(path) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = authorizedPaths.get(path);
      if (!entry) return false;
      try {
        if (realpathSync(path) !== entry.canonicalPath || !isRegularFileSync(path)) {
          authorizedPaths.delete(path);
          return false;
        }
      } catch {
        authorizedPaths.delete(path);
        return false;
      }
      entry.lastUsedAt = observedAt;
      return true;
    },
    clear() {
      authorizedPaths.clear();
    },
  };
}

/**
 * Electron requires privileged schemes to be registered before the app is ready.
 * Without `standard`, Chromium does not read from the end of the file as a standard URL would, so
 * MP4s whose `moov` atom sits after `mdat` are misjudged as undecodable; `standard` together with
 * `stream` is what preserves metadata reads and seeking for local video.
 */
export function registerLocalMediaPreviewScheme(protocol: LocalMediaPreviewSchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
  ]);
}

export function installLocalMediaPreviewProtocol(
  protocol: LocalMediaPreviewProtocol,
  options: { isPathAuthorized: (path: string) => boolean },
): void {
  if (installedProtocols.has(protocol)) return;
  // protocol.handle(Response) cannot provide stable performance for local audio and video in Electron 41
  // seekable range, manually returning the Range will be judged as unplayable by the media stack. Reuse native file loader,
  // Let Chromium handle the Range while still only passing the verified absolute paths of audio and video to the loader.
  const registered = protocol.registerFileProtocol(
    LOCAL_MEDIA_PREVIEW_SCHEME,
    (request, callback) => {
      try {
        const url = new URL(request.url);
        const path = url.searchParams.get("path") ?? "";
        if (
          url.hostname !== "local" ||
          url.pathname !== "/preview" ||
          !options.isPathAuthorized(path)
        ) {
          callback({ error: NET_ERR_INVALID_URL });
          return;
        }
        callback(path);
      } catch {
        callback({ error: NET_ERR_INVALID_URL });
      }
    },
  );
  if (!registered) throw new Error("Failed to register local media preview protocol");
  installedProtocols.add(protocol);
}

export { buildLocalMediaPreviewUrl };
