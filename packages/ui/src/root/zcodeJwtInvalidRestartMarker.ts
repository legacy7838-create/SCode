const ZCODE_JWT_INVALID_RESTART_MARKER_KEY = "zcode:auth:jwt-invalid-restart";

interface RestartMarkerStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: RestartMarkerStorage): RestartMarkerStorage | null {
  if (storage) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function markZcodeJwtInvalidRestart(storage?: RestartMarkerStorage): void {
  resolveStorage(storage)?.setItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY, "1");
}

export function consumeZcodeJwtInvalidRestartMarker(storage?: RestartMarkerStorage): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved || resolved.getItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY) !== "1") {
    return false;
  }
  // This mark only serves this restart; if it is not deleted during reading, subsequent normal startups will still be forced back to the login page.
  resolved.removeItem(ZCODE_JWT_INVALID_RESTART_MARKER_KEY);
  return true;
}
