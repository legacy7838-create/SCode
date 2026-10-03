import { create } from "zustand";

/**
 * GitHub 仓库侧边栏打开请求桥接 Store。
 * 当用户在 GitHub 活动悬浮卡片中点击箭头按钮时，触发 requestOpen，
 * useAppPanels 中的 useGitHubReposOpenBridge 监听到请求后，自动展开第 3 个 Toggle Panel（侧边栏），
 * 并激活 github-repos Tab 显示用户的全部仓库。
 */
interface GitHubReposOpenRequest {
  requestId: string;
  workspaceKey?: string;
}

interface GitHubReposStoreState {
  pendingRequest: GitHubReposOpenRequest | null;
  requestOpen: (workspaceKey?: string) => void;
  consumeRequest: (requestId: string) => void;
}

let requestSeq = 0;

export const useGitHubReposStore = create<GitHubReposStoreState>((set) => ({
  pendingRequest: null,
  requestOpen: (workspaceKey) => {
    requestSeq += 1;
    set({
      pendingRequest: { workspaceKey, requestId: `github-repos-open:${requestSeq}` },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));
