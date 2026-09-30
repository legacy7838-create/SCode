/**
 * Hooks barrel export
 *
 * All hooks for services and platform actions are exported from here. Components should reach
 * services through hooks instead of using services.* or window.zcode.* directly.
 */

// service context
export { ServiceProvider, useServices } from "./useServices.js";
export { useBaseWorkspaceServices, useWorkspaceServices } from "./useWorkspaceServices.js";

// platform operating context
export {
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
} from "./usePlatform.js";

// file service
export { useReaddir } from "./useFileService.js";

// file monitoring service
export { useWatchedReaddir } from "./useFileWatcherService.js";

// System services
export { useSystemInfo, useIntranetProbe } from "./useSystemService.js";
export { useWorkspaceHomePath } from "./useWorkspaceHomePath.js";

// terminal services
export { useTerminal } from "./useTerminalService.js";

// Set up service
export { useSettings, useRecentProjects } from "./useSettingService.js";
export { useSkills } from "./useSkills.js";
export { usePlugins } from "./usePlugins.js";

// Onboarding completes the recording service (local persistence, subsequent upload to the server)
export { useOnboardingRecordService } from "./useOnboardingRecordService.js";

// Universal confirmation popup
export { useConfirmDialog } from "./useConfirmDialog.js";
export { useAlertDialog } from "./useAlertDialog.js";

// Credential service
export { useCredentials, useAuthToken } from "./useCredentials.js";
export { useZCodeAgentService } from "./useZCodeAgentService.js";

// Git pane
export { useGitAutoRefresh } from "./useGitAutoRefresh.js";
export { useGitRepository } from "./useGitRepository.js";
export { useGitActions } from "./useGitActions.js";
// workspace provider configuration path
export { useTaskNativeSessionLogFile } from "./useTaskNativeSessionLogFile.js";
export { useTaskSessionFilePath } from "./useTaskSessionFilePath.js";
export { useUsageStats } from "./useUsageStats.js";
