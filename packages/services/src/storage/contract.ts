/**
 * Public contract of the storage module: re-exports the service interface and types used by the
 * resource manager's "Storage" tab.
 * Importing from here is the only option; implementation details (Worker, fs, catalog rules) stay
 * inside the module.
 */
import type { Event } from "@zcode/rpc";
import type { StorageManagementApi, StorageUsageSnapshot } from "@zcode/shared";

// The single source of truth for data types is in @zcode/shared (shared by renderer bridge and main); re-exported here for convenient use within services.
export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanRequest,
  StorageCleanResult,
  StorageCleanability,
  StorageEntryUsage,
  StorageManagementApi,
  StoragePathError,
  StorageRootId,
  StorageRootSpec,
  StorageRootUsage,
  StorageScanStatus,
  StorageUsageSnapshot,
  StorageVolume,
  StorageVolumeGroup,
} from "@zcode/shared";

/**
 * The storage service instance interface. Currently desktop main holds a single instance (dedicated
 * to the resource manager window); it is no longer registered as a host RPC service, so there is
 * no ServiceDescriptor / channel.
 */
export interface IStorageService extends StorageManagementApi {
  onScanProgress: Event<StorageUsageSnapshot>;
  /** Cancels the in-flight scan and releases the event source. */
  dispose(): void;
}
