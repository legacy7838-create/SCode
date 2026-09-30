import { useRef } from "react";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";

type StableAccountAccess = ZCodeProviderAccountAccess | ZCodeAccountAccess;

/**
 * Schema resolution produces a new object for the same Account Access; hook dependencies must be
 * stable by configuration value.
 */
export function useStableAccountAccess(
  accountAccess: StableAccountAccess | null | undefined,
): StableAccountAccess | undefined {
  const normalized = accountAccess ?? undefined;
  const key = JSON.stringify(accountAccess ?? null);
  const stable = useRef({ key, value: normalized });
  if (stable.current.key !== key) {
    stable.current = { key, value: normalized };
  }
  return stable.current.value;
}
