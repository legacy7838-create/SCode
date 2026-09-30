import type { RemoteTarget } from "./remoteTarget.js";
import type { TelemetryEventPayload } from "./telemetry.js";
import {
  parseRemoteWorkspaceIdentity,
  type RemoteWorkspaceIdentityKind,
} from "./remote-workspace-identity.js";

/** Extracts only the scenario enum; an unknown remote identity stays "remote", and addresses or paths must never be exposed to product telemetry. */
export function resolveWorkspaceTelemetryDetail(scope: {
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
}): { workspace_kind: "local" | "remote"; remote_kind: RemoteWorkspaceIdentityKind | "" } {
  const identity = scope.workspaceIdentity?.trim();
  return {
    workspace_kind: identity || scope.remoteSessionId?.trim() ? "remote" : "local",
    remote_kind: identity ? (parseRemoteWorkspaceIdentity(identity)?.kind ?? "") : "",
  };
}

export type RemoteUsageRemoteKind = RemoteTarget["kind"];
export type RemoteUsageWorkspaceKind = "local" | "remote";
export type RemoteUsageResult = "success" | "failure";
export type RemoteWorkspaceConnectTrigger = "new" | "reconnect" | "restore";
export type RemoteUsageErrorCategory =
  | "auth"
  | "connect"
  | "deploy"
  | "host_start"
  | "attach"
  | "relay"
  | "unknown";

export function buildRemoteWorkspaceConnectResultTelemetry(input: {
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): TelemetryEventPayload {
  return {
    elementName: "remote_workspace_connect_result",
    eventRegion: "remote_workspace",
    eventType: "result",
    eventExtraDetail: {
      result: input.result,
      remote_kind: input.remoteKind,
      connect_trigger: input.connectTrigger,
      error_category: input.result === "success" ? "" : (input.errorCategory ?? "unknown"),
    },
  };
}

function readErrorSearchText(error: unknown): string {
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return `${code} ${message}`.toLowerCase();
}

/**
 * The raw error only participates in local matching; the return value is always a low-cardinality enum, and the remote target or error message must never be carried into telemetry.
 */
export function classifyRemoteUsageError(error: unknown): RemoteUsageErrorCategory {
  const value = readErrorSearchText(error);
  if (/(auth|password|credential|token|permission|denied|unauthor)/.test(value)) {
    return "auth";
  }
  if (/(deploy|download|install|asset|checksum)/.test(value)) {
    return "deploy";
  }
  if (/(host_start|host start|spawn|process.*(?:exit|start)|host.*(?:exit|start))/.test(value)) {
    return "host_start";
  }
  if (
    /(attach|desktop_host_missing|workspace.*(?:identity|missing|mismatch)|remote_session)/.test(
      value,
    )
  ) {
    return "attach";
  }
  if (/(relay|websocket|web socket|pair|device.*(?:kicked|not.found))/.test(value)) {
    return "relay";
  }
  if (/(connect|network|socket|ssh|wsl|server|timeout|timedout|econn)/.test(value)) {
    return "connect";
  }
  return "unknown";
}
