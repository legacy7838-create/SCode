import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { useSkillStore } from "@/store/skillStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

declare global {
  interface Window {
    __skillStoreE2E?: typeof useSkillStore;
    __subagentsStoreE2E?: typeof useSubagentsStore;
    __whiteboardStoreE2E?: typeof useWhiteboardStore;
    __zcodeSessionStoreE2E?: typeof useZCodeSessionStore;
  }
}

export function registerE2EStoreBridges() {
  if (!shouldExposeE2EStoreBridge()) {
    return;
  }

  // Some E2Es may not import naturally when started from the settings page, error page or special route.
  // Corresponds to the store module. Renderer bootstrap is explicitly registered to ensure stable preflight and test injection.
  window.__zcodeSessionStoreE2E = useZCodeSessionStore;
  window.__skillStoreE2E = useSkillStore;
  window.__subagentsStoreE2E = useSubagentsStore;
  window.__whiteboardStoreE2E = useWhiteboardStore;
}
