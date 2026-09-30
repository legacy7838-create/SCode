import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeArchivedTaskDeletionResult } from "#src/session/zcodeTaskService.js";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
} from "../session/zcodeTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = ZCodeTaskListItem & {
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<ZCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/**
 * The window-level Controller service only carries list projection and cross-source routing.
 * conversation/file/git/terminal are still provided by the scoped facade of the corresponding
 * attachment.
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ZCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
