import type { TaskChatMessage as ChatMessage } from "@/lib/taskChatMessageTypes.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { IZCodeAgentService } from "@zcode/services";
import type { TaskListE2EActions } from "@/lib/taskListE2EActions.js";
import { useEffect } from "react";

// Type declarations for Vite-injected import.meta.env
declare global {
  interface ImportMeta {
    env: { PROD: boolean; DEV: boolean; [key: string]: unknown };
  }
}

/**
 * The set of actions E2E tests can call through window.__testActions. Registered only in
 * non-production environments, so nothing leaks into production.
 */
export interface TestActions extends TaskListE2EActions {
  /** Get the current theme */
  getTheme: () => string;
  /** Set the theme */
  setTheme: (theme: "light" | "dark" | "zai-light" | "zai-dark" | "system") => void;
  /** Get the current language, only for cross-language display E2E */
  getLocale: () => "en-US";
  /** Set the current language, only for cross-language display E2E */
  setLocale: (locale: "en-US") => void;
  /** Inject mock messages for chat display */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Get the current mock message count */
  getChatMessageCount: () => number;
  /** E2E fetches the plugin overview through the real zcodeAgentService */
  getPluginsOverview: IZCodeAgentService["getPluginsOverview"];
  /** E2E adds a marketplace through the real zcodeAgentService */
  addPluginMarketplace: IZCodeAgentService["addPluginMarketplace"];
  /** E2E refreshes a marketplace through the real zcodeAgentService */
  updatePluginMarketplace: IZCodeAgentService["updatePluginMarketplace"];
  /** E2E installs a marketplace plugin through the real zcodeAgentService */
  installPlugin: IZCodeAgentService["installPlugin"];
  /** E2E triggers plugin discover through the real zcodeAgentService */
  listPlugins: IZCodeAgentService["listPlugins"];
  /** E2E queries the Workspace/Session Plugin catalog through the real zcodeAgentService */
  getPluginReferenceCatalog: IZCodeAgentService["getPluginReferenceCatalog"];
}

declare global {
  interface Window {
    __testActions?: TestActions;
  }
}

/**
 * Register the test actions onto window.__testActions. Registration is skipped only when
 * import.meta.env.PROD is true (Vite environment).
 */
export function useTestActions(actions: TestActions) {
  useEffect(() => {
    // E2E production renderer also needs the service entry; it can only be opened by a dedicated bridge switch to avoid leaking into normal production builds.
    if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;
    window.__testActions = actions;
    return () => {
      actions.releaseTaskMembershipRefreshHold();
      delete window.__testActions;
    };
  }, [actions]);
}
