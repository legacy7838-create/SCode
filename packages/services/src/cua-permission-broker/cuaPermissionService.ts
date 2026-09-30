// Computer Use Helper macOS permission service — services-side descriptor registration.
//
// As part of the single-package merge the type definitions + functional helpers
// (CuaPermissionStatus, CuaPermissionStatusResult, isCuaPermissionStatusAvailable,
// shouldRunCuaScreenCaptureProbe, ICuaPermissionService interface, etc.) moved
// to @zcode/zcode-cua/src/broker/ports.ts. The descriptor registration itself stays in
// services (host control plane — depends on services' createServiceDescriptor
// + @zcode/shared ServiceChannels), so services internal callers (node.ts,
// accessor.ts, services/index.ts) and ui consumers (via @zcode/services root
// export) keep importing `ICuaPermissionService` from this exact path.
//
// The producer only owns the type contract; the VALUE descriptor continues to be represented by the services
// CreateServiceDescriptor is created to avoid producer's reverse dependence on RPC/service registry.

import { ServiceChannels } from "@zcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

// Type layer — type-only imports from the consolidated package (erased by TS
// at compile time; Vite never resolves @zcode/zcode-cua for these).
import type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
  ICuaPermissionService as BrokerICuaPermissionService,
} from "@zcode/zcode-cua/broker";

// Re-export types for consumers.
export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
};

// Only reuse value predicates from the producer's pure ports subpath. This cannot be done from the Node-only broker barrel
// re-export, otherwise the renderer bundle will introduce process/node:path/node:crypto; the implementation can no longer be copied.
// Otherwise, the privacy contract of "Omit options to automatically capture the screen" will drift again.
export {
  isCuaPermissionStatusAvailable,
  shouldRunCuaScreenCaptureProbe,
} from "@zcode/zcode-cua/broker/ports";

export interface ICuaPermissionService extends BrokerICuaPermissionService {}

export const ICuaPermissionService = createServiceDescriptor<BrokerICuaPermissionService>(
  ServiceChannels.CuaPermission,
);
