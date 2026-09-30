import type {
  OffPeakCodingPlanSupport,
  OffPeakTaskCreateResult,
  OffPeakTakeNumberAvailability,
  ZCodeOffPeakTask,
  ZCodeOffPeakTaskCreateParams,
  ModelSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// Free-time task management service channel (not reused with the automation service plane).
// The renderer is directly connected via ProxyChannel (same paradigm as codingPlanSubscription);
// Polling/number retrieval/cancellation is driven internally by the service and is not exposed to the renderer.

export interface OffPeakUpdateTaskParams {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  /** undefined=Do not change; Off-Peak Submission is not allowed to be cleared to follow the default. */
  modelSelection?: ModelSelection | null;
}

export interface IOffPeakTaskService {
  /** Masking of the currently selected provider/connection supports snapshots; secrets do not go through renderer RPCs. */
  getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport>;
  /** Instant snapshot of the server's account quota; only new entries are controlled, POST /ticket is still the final access authority. */
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  /** The number is obtained immediately after creation (it will be dropped into the database only after success); if it fails, the stable classification will be returned, and raw errors will not be transmitted across RPC. */
  createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult>;
  cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  deleteTask(offPeakTaskId: string): Promise<void>;
  /** Only the local History row is hidden; task/session/execution fields are not deleted. */
  deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null>;
  list(): Promise<ZCodeOffPeakTask[]>;
  get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
}

export const IOffPeakTaskService = createServiceDescriptor<IOffPeakTaskService>(
  ServiceChannels.OffPeakTask,
);
