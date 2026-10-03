import { useEffect } from "react";
import { useGitHubReposStore } from "@/store/githubReposStore.js";

/**
 * 监听在侧边栏（第 3 个 Toggle Panel）中打开 GitHub Repositories 面板的请求。
 * 当请求发起时，匹配目标工作区并调用 onOpen 展开侧边栏与激活仓库 Tab。
 */
export function useGitHubReposOpenBridge(
  ownWorkspaceKey: string,
  onOpen: () => void,
): void {
  useEffect(() => {
    const handlePending = (
      pendingRequest: ReturnType<typeof useGitHubReposStore.getState>["pendingRequest"],
    ) => {
      if (!pendingRequest) {
        return;
      }
      if (pendingRequest.workspaceKey && pendingRequest.workspaceKey !== ownWorkspaceKey) {
        return;
      }
      onOpen();
      useGitHubReposStore.getState().consumeRequest(pendingRequest.requestId);
    };

    handlePending(useGitHubReposStore.getState().pendingRequest);
    return useGitHubReposStore.subscribe((state) => {
      handlePending(state.pendingRequest);
    });
  }, [onOpen, ownWorkspaceKey]);
}
