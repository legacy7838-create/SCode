import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "./provider-config-file-codec.js";

export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #filePath: string;
  readonly #importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly #onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly #onPollingError?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #pollingErrorActive = false;
  #observedRevision: string | null = null;
  #disposed = false;

  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim())
      throw new Error("Personal Provider Config filePath must not be empty");
    this.#filePath = options.filePath;
    this.#importLegacy = options.importLegacy;
    this.#onRecovery = options.onRecovery;
    this.#onPollingError = options.onPollingError;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    if (this.#pollingIntervalMs !== false && this.#pollingIntervalMs <= 0) {
      throw new Error("Personal Provider Config pollingIntervalMs must be greater than 0");
    }
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readCurrent();
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } catch (error) {
      const snapshot = this.#recoverInvalidFile(error);
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await withFileLock(this.#filePath, async () => {
        const current = await this.#readLocked();
        const next = transform(current);
        const update = Object.freeze({
          providers: next.providers,
          models: next.models,
          providerOrder: next.providerOrder,
          defaultModelSelection: next.defaultModelSelection,
        });
        const committed = await this.#writeLocked(update);
        const snapshot = snapshotFromUpdate(committed);
        // Atomic writes may generate multiple file system events. After writing is completed, record the content version first.
        // Polling will not issue invalidation notifications again when the same version is subsequently read.
        this.#observedRevision = snapshot.revision;
        return snapshot;
      });
      this.#emit("updated");
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
    this.#listeners.clear();
  }

  async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {
    // Multiple processes competing for exclusive locks for pure reading will amplify polling into lock timeouts due to slow IO.
    // Formal documents are atomically replaced through temporary files in the same directory, and pure reading can directly observe the complete document that has been submitted.
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null && !this.#importLegacy) return snapshotFromUpdate(emptyUpdate());
    if (file !== null) {
      const update = decodeProviderConfigFile(file.value);
      if (JSON.stringify(file.value) === JSON.stringify(encodeProviderConfigFile(update))) {
        return snapshotFromUpdate(update);
      }
    }
    // Importing and normalizing will still write to disk. You must reread after taking the lock, and other writers cannot be overwritten with the old content before the lock.
    return withFileLock(this.#filePath, () => this.#readLocked());
  }

  async #readLocked(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) {
      const imported = await this.#importLegacy?.();
      const update = imported ?? emptyUpdate();
      if (imported) return snapshotFromUpdate(await this.#writeLocked(update));
      return snapshotFromUpdate(update);
    }

    const update = decodeProviderConfigFile(file.value);
    const encoded = encodeProviderConfigFile(update);
    if (JSON.stringify(file.value) !== JSON.stringify(encoded)) {
      await this.#writeLocked(update);
    }
    return snapshotFromUpdate(update);
  }

  async #writeLocked(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    // Write rules and default selections for the same entry; strictly verify the entire result first, and do not place the order before discovering that the source has exceeded authority/bad value.
    // Use the same canonical form used to read and then calculate the version to avoid the outer rule key sequence causing the "successfully written" version to change when read back.
    const canonical = decodeProviderConfigFile(encodeProviderConfigFile(update));
    const encoded = encodeProviderConfigFile(canonical);
    await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
    this.#writeGeneration += 1;
    return canonical;
  }

  async #readPollingSnapshot(): Promise<ProviderConfigLayerSnapshot> {
    const file = await readJsonFileIfExists(this.#filePath);
    if (file === null) return snapshotFromUpdate(emptyUpdate());
    return snapshotFromUpdate(decodeProviderConfigFile(file.value));
  }

  #recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {
    // When the official file is invalid, it must be kept as it is and cannot be backed up and then overwritten into an empty configuration; this process only uses empty memory
    // Overlay is downgraded, waiting for the user to repair the original file.
    this.#reportRecovery({ error });
    return snapshotFromUpdate(emptyUpdate());
  }

  #reportRecovery(event: PersonalProviderConfigRecoveryEvent): void {
    try {
      this.#onRecovery?.(Object.freeze(event));
    } catch {
      // Observation callbacks are not configuration facts and cannot reversely block recovery.
    }
  }

  #ensurePolling(): void {
    // The timer is cleared while the poll is in flight; explicit read/update finallys cannot be queued to a second round.
    if (
      this.#pollingIntervalMs === false ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readPollingSnapshot();
      // After removing the read lock, the old poll may be saved and returned later than the process; discard it to avoid version regression and repeated notifications.
      if (writeGeneration !== this.#writeGeneration) return;
      this.#pollingErrorActive = false;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch (error) {
      // A successful save also invalidates the failure of the old poll, and the failure of the old read operation cannot be reissued after the new version.
      if (this.#disposed || writeGeneration !== this.#writeGeneration) return;
      if (!this.#pollingErrorActive) {
        this.#pollingErrorActive = true;
        try {
          this.#onPollingError?.(error);
        } catch {
          // The observation callback cannot reversely block the next round of self-healing.
        }
        this.#emit("poll-error");
      }
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository has been disposed");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

async function readJsonFileIfExists(filePath: string): Promise<{ readonly value: unknown } | null> {
  try {
    const text = await readFile(filePath, "utf8");
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

function snapshotFromUpdate(update: ProviderConfigLayerUpdate): ProviderConfigLayerSnapshot {
  const content = JSON.stringify(encodeProviderConfigFile(update));
  return Object.freeze({
    revision: createHash("sha256").update(content).digest("hex"),
    providers: update.providers,
    models: update.models,
    // The snapshot must be consistent with the disk content corresponding to the revision; padding the array will cause files that do not declare sorting to falsely report changes during CAS.
    providerOrder: update.providerOrder,
    defaultModelSelection: update.defaultModelSelection,
  });
}
