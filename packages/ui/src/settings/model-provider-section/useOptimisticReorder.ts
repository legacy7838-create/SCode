import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface PendingReorder {
  readonly operationId: number;
  readonly ids: readonly string[];
}

interface OptimisticReorderController {
  readonly renderedIds: readonly string[];
  commit(ids: readonly string[]): Promise<void>;
}

export function useOptimisticReorder({
  authoritativeIds,
  persist,
}: {
  authoritativeIds: readonly string[];
  persist: (ids: readonly string[]) => Promise<void>;
}): OptimisticReorderController {
  const [pending, setPending] = useState<PendingReorder | null>(null);
  const nextOperationIdRef = useRef(0);
  const persistenceTailRef = useRef<Promise<void>>(Promise.resolve());
  const persistOwnerRef = useRef(persist);

  useLayoutEffect(() => {
    if (persistOwnerRef.current === persist) return;
    persistOwnerRef.current = persist;
    // When switching Environment/Service Owner, you cannot continue even if the Provider members are exactly the same
    // Exhibit or serialize pending operations from the old environment. Advancing the operation id invalidates the late result of the old Promise.
    nextOperationIdRef.current += 1;
    persistenceTailRef.current = Promise.resolve();
    setPending(null);
  }, [persist]);

  const renderedIds = useMemo(
    () =>
      pending && haveSameMembers(authoritativeIds, pending.ids) ? pending.ids : authoritativeIds,
    [authoritativeIds, pending],
  );

  useEffect(() => {
    setPending((current) => {
      if (!current) return current;
      if (
        haveSameOrder(authoritativeIds, current.ids) ||
        !haveSameMembers(authoritativeIds, current.ids)
      ) {
        return null;
      }
      return current;
    });
  }, [authoritativeIds]);

  const commit = useCallback(
    (ids: readonly string[]): Promise<void> => {
      const nextIds = [...ids];
      const operationId = nextOperationIdRef.current + 1;
      nextOperationIdRef.current = operationId;
      setPending({ operationId, ids: nextIds });

      // The drag library will clear the transform immediately when the pointer is up, and the official Settings View
      // It will arrive after file writing and Registry refresh. Here we first retain the user’s latest sorting as a pure UI
      // pending intent, and written serially to avoid old requests being late and overwriting the final order of consecutive drags.
      const operation = persistenceTailRef.current
        .catch(() => undefined)
        .then(() => persist(nextIds));
      persistenceTailRef.current = operation;

      return operation.catch((error: unknown) => {
        setPending((current) => (current?.operationId === operationId ? null : current));
        throw error;
      });
    },
    [persist],
  );

  return { renderedIds, commit };
}

function haveSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function haveSameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftIds = new Set(left);
  return leftIds.size === right.length && right.every((id) => leftIds.has(id));
}
