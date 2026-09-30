// macOS permission state of the Computer Use Helper. The state comes from the Helper's current runtime preflight;
// historical TCC rows do not participate in the decision; see cuaPermissionStatusStore's isCuaPermissionTccGranted for the display criteria.
//
// The refresh strategy **no longer polls on a timer**; it is event-driven, pulling exactly once at each of three moments —
// - mount (entering the Settings page / the composer entry's first render);
// - the window regains focus (the user just came back from authorizing in macOS System Settings);
// - an explicit refresh from the caller (plugin toggle, Helper restart, the authorization return recovery chain).
//
// Why polling was removed: the grant state is a low-frequency event, and per-second polling not only hammers host RPC but also makes the UI jitter continuously —
// every query round sets fresh back to false, so the Settings page's authorization button flip-flops between "Open System Settings" and "Verifying…".
// The state itself lives in a process-wide shared cache in lib/cuaPermissionStatusStore;
// the Settings page and the composer entry read the same copy, so re-entering the page renders the last known state first instead of flashing from "unknown".
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CuaPermissionStatusQueryOptions, CuaPermissionStatusResult } from "@zcode/services";
import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
  subscribeCuaPermissionStatus,
} from "@/lib/cuaPermissionStatusStore.js";
import { useOptionalServices } from "./useServices.js";

export function useCuaPermissionStatus(
  workspacePath: string | null,
  workspaceIdentity?: string,
): {
  status: CuaPermissionStatusResult | null;
  fresh: boolean;
  /** Stable flag for display: true whenever there is something to show; it does not fall back with each query. See the comment inside the store. */
  settled: boolean;
  refresh: (options?: CuaPermissionStatusQueryOptions) => void;
} {
  const services = useOptionalServices();
  // cuaPermissionService is an optional field in main (remote hosts have no CUA). When it's missing, no query runs and
  // the snapshot is always empty — callers display "unknown" accordingly.
  const cuaPermissionService = services?.cuaPermissionService;
  const key =
    workspacePath && cuaPermissionService
      ? cuaPermissionStatusKey(workspacePath, workspaceIdentity)
      : null;

  const snapshot = useSyncExternalStore(
    subscribeCuaPermissionStatus,
    useCallback(() => getCuaPermissionStatusSnapshot(key), [key]),
  );

  const query = useCallback(
    (mode: "refresh" | "ensure", options?: CuaPermissionStatusQueryOptions): void => {
      if (!workspacePath || !cuaPermissionService) return;
      fetchCuaPermissionStatus({
        service: cuaPermissionService,
        workspacePath,
        mode,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(options ? { options } : {}),
      });
    },
    [cuaPermissionService, workspaceIdentity, workspacePath],
  );

  const refresh = useCallback(
    (options?: CuaPermissionStatusQueryOptions): void => query("refresh", options),
    [query],
  );

  useEffect(() => {
    if (!workspacePath || !cuaPermissionService) return;
    // Pull once on page entry. The Settings page and the composer entry may mount in either order; ensure lets the latter piggyback on the former's in-flight query.
    query("ensure");
    // The user just came back from authorizing in macOS System Settings: the state may have changed, so it must be a forced re-query.
    const onFocus = (): void => query("refresh");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cuaPermissionService, query, workspacePath]);

  return {
    status: snapshot.status,
    fresh: snapshot.fresh,
    settled: snapshot.settled,
    refresh,
  };
}
