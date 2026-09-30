export interface BrowserReadableStorageLike {
  getItem(key: string): string | null;
}

export interface BrowserStorageLike extends BrowserReadableStorageLike {
  setItem(key: string, value: string): void;
}

function getLocalStorageCandidate(): unknown {
  try {
    return typeof window !== "undefined"
      ? window.localStorage
      : typeof localStorage !== "undefined"
        ? localStorage
        : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserReadableStorageLike(storage: unknown): storage is BrowserReadableStorageLike {
  return (
    Boolean(storage) &&
    typeof (storage as Partial<BrowserReadableStorageLike>).getItem === "function"
  );
}

function isBrowserStorageLike(storage: unknown): storage is BrowserStorageLike {
  return (
    isBrowserReadableStorageLike(storage) &&
    typeof (storage as Partial<BrowserStorageLike>).setItem === "function"
  );
}

function getSafeReadableLocalStorage(): BrowserReadableStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserReadableStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function getSafeLocalStorage(): BrowserStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function readSafeLocalStorage(key: string): string | null {
  try {
    return getSafeReadableLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSafeLocalStorage(key: string, value: string): void {
  try {
    getSafeLocalStorage()?.setItem(key, value);
  } catch {
    // localStorage may exist but not be writable in SSR/test environment or private mode.
    // Writing failures should not block UI rendering, and real preferences can still be restored from the settingService or default values ​​next time.
  }
}

export function readNavigatorLanguage(): string | null {
  if (typeof navigator === "undefined" || typeof navigator.language !== "string") {
    return null;
  }

  return navigator.language;
}
