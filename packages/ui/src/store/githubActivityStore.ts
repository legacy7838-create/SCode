import { create } from "zustand";
import {
  type GitHubUserProfile,
  type GitHubActivityState,
  STORAGE_KEY,
} from "@/store/githubActivityTypes.js";
import {
  fetchFullGitHubActivity,
  generateFallbackData,
  fetchUserRepositories,
} from "@/store/githubActivityService.js";
import { validateGitHubToken } from "@/store/githubGraphqlService.js";

export * from "@/store/githubActivityTypes.js";

function loadPersistedSession(): Partial<GitHubActivityState> {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.username === "string" && parsed.username) {
      const availableYears =
        Array.isArray(parsed.availableYears) && parsed.availableYears.length > 0
          ? parsed.availableYears
          : [2026, 2025, 2024];

      const selectedYear =
        typeof parsed.selectedYear === "number" && availableYears.includes(parsed.selectedYear)
          ? parsed.selectedYear
          : availableYears[0];

      const yearsData =
        parsed.yearsData && Object.keys(parsed.yearsData).length > 0
          ? parsed.yearsData
          : generateFallbackData(parsed.username);

      return {
        isConnected: true,
        isLoggedIn: Boolean(parsed.isLoggedIn),
        token: typeof parsed.token === "string" ? parsed.token : null,
        profile: {
          username: parsed.username,
          name: parsed.name ?? parsed.username,
          avatarUrl: parsed.avatarUrl ?? `https://github.com/${parsed.username}.png`,
          publicRepos: parsed.publicRepos ?? 0,
          totalContributions:
            parsed.totalContributions ?? yearsData[selectedYear]?.totalCount ?? 0,
        },
        selectedYear,
        startMonth: 7, // 默认聚焦到当前 8~10 月
        selectedMonth: "all",
        availableYears,
        yearsData,
      };
    }
  } catch {
    // 忽略持久化反序列化异常
  }
  return {};
}

const initial = loadPersistedSession();

export const useGitHubActivityStore = create<GitHubActivityState>((set, get) => ({
  isConnected: initial.isConnected ?? false,
  isLoggedIn: initial.isLoggedIn ?? false,
  token: initial.token ?? null,
  repos: [],
  isReposLoading: false,
  reposError: null,
  profile: initial.profile ?? null,
  selectedYear: initial.selectedYear ?? 2026,
  startMonth: initial.startMonth ?? 7,
  selectedMonth: initial.selectedMonth ?? "all",
  availableYears: initial.availableYears ?? [2026, 2025, 2024],
  yearsData: initial.yearsData ?? {},
  isLoading: false,
  error: null,

  setSelectedYear: (year: number) => {
    set({
      selectedYear: year,
      startMonth: year === 2026 ? 7 : 9,
      selectedMonth: "all",
    });
  },

  setStartMonth: (month: number) => {
    set({
      startMonth: Math.max(0, Math.min(9, month)),
      selectedMonth: "all",
    });
  },

  setSelectedMonth: (month: number | "all") => {
    set({ selectedMonth: month });
  },

  /**
   * 修复说明（中）：
   * 向前切换 3 个月窗口。如果在当前年份已到达 1 月（startMonth === 0），
   * 自动无缝切换到上一年度的年末 3 个月（startMonth = 9），保证历史数据随时可回溯。
   */
  prevWindow: () => {
    const { startMonth, selectedYear, availableYears } = get();
    if (startMonth > 0) {
      set({ startMonth: startMonth - 1, selectedMonth: "all" });
    } else {
      const currentIdx = availableYears.indexOf(selectedYear);
      if (currentIdx !== -1 && currentIdx < availableYears.length - 1) {
        const prevYear = availableYears[currentIdx + 1];
        if (prevYear !== undefined) {
          set({
            selectedYear: prevYear,
            startMonth: 9,
            selectedMonth: "all",
          });
        }
      }
    }
  },

  /**
   * 修复说明（中）：
   * 向后切换 3 个月窗口。如果在当前年份已到达末尾（startMonth === 9），
   * 自动无缝切换到下一年度的年初 3 个月（startMonth = 0）。
   */
  nextWindow: () => {
    const { startMonth, selectedYear, availableYears } = get();
    if (startMonth < 9) {
      set({ startMonth: startMonth + 1, selectedMonth: "all" });
    } else {
      const currentIdx = availableYears.indexOf(selectedYear);
      if (currentIdx > 0) {
        const nextYear = availableYears[currentIdx - 1];
        if (nextYear !== undefined) {
          set({
            selectedYear: nextYear,
            startMonth: 0,
            selectedMonth: "all",
          });
        }
      }
    }
  },

  connect: async (rawUsername: string) => {
    const username = rawUsername.trim().replace(/^@/, "");
    if (!username) return;

    set({ isLoading: true, error: null });

    try {
      const data = await fetchFullGitHubActivity(username, get().token);

      const profile: GitHubUserProfile = {
        username,
        name: data.name,
        avatarUrl: data.avatarUrl,
        publicRepos: data.publicRepos,
        totalContributions: data.totalContributions,
      };

      try {
        if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              username,
              name: data.name,
              avatarUrl: data.avatarUrl,
              publicRepos: data.publicRepos,
              totalContributions: data.totalContributions,
              selectedYear: data.activeYear,
              availableYears: data.availableYears,
              yearsData: data.yearsData,
              isLoggedIn: get().isLoggedIn,
              token: get().token,
            }),
          );
        }
      } catch {
        // 忽略存储异常
      }

      set({
        isConnected: true,
        profile,
        selectedYear: data.activeYear,
        startMonth: data.activeYear === 2026 ? 7 : 9,
        selectedMonth: "all",
        availableYears: data.availableYears,
        yearsData: data.yearsData,
        isLoading: false,
        error: null,
      });

      if (get().isLoggedIn) {
        void get().fetchRepos();
      }
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load GitHub activity",
      });
    }
  },

  login: async (token?: string) => {
    const cleanToken = token?.trim() || null;
    set({ isLoading: true, error: null });

    try {
      let targetUsername = get().profile?.username || "";
      if (cleanToken) {
        // 验证 Token 并获取准确用户名与私人仓库权限
        const validated = await validateGitHubToken(cleanToken);
        targetUsername = validated.username;
      }

      if (!targetUsername) {
        throw new Error("Please connect a GitHub username or provide a Personal Access Token.");
      }

      // 拉取包含私人仓库与私人贡献在内的完整数据
      const data = await fetchFullGitHubActivity(targetUsername, cleanToken);
      const repos = await fetchUserRepositories(targetUsername, cleanToken);

      const profile: GitHubUserProfile = {
        username: targetUsername,
        name: data.name,
        avatarUrl: data.avatarUrl,
        publicRepos: data.publicRepos,
        totalContributions: data.totalContributions,
      };

      try {
        if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              username: targetUsername,
              name: data.name,
              avatarUrl: data.avatarUrl,
              publicRepos: data.publicRepos,
              totalContributions: data.totalContributions,
              selectedYear: data.activeYear,
              availableYears: data.availableYears,
              yearsData: data.yearsData,
              isLoggedIn: true,
              token: cleanToken,
            }),
          );
        }
      } catch {
        // 忽略存储异常
      }

      set({
        isConnected: true,
        isLoggedIn: true,
        token: cleanToken,
        profile,
        repos,
        selectedYear: data.activeYear,
        startMonth: data.activeYear === 2026 ? 7 : 9,
        selectedMonth: "all",
        availableYears: data.availableYears,
        yearsData: data.yearsData,
        isLoading: false,
        isReposLoading: false,
        error: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to log in to GitHub",
      });
      throw err;
    }
  },

  logout: () => {
    set({
      isLoggedIn: false,
      token: null,
      repos: [],
      reposError: null,
    });

    try {
      if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              ...parsed,
              isLoggedIn: false,
              token: null,
            }),
          );
        }
      }
    } catch {
      // 忽略存储异常
    }
  },

  fetchRepos: async () => {
    const { profile, token } = get();
    if (!profile?.username) return;

    set({ isReposLoading: true, reposError: null });

    try {
      const repos = await fetchUserRepositories(profile.username, token);
      set({
        repos,
        isReposLoading: false,
        reposError: null,
      });
    } catch (err) {
      set({
        isReposLoading: false,
        reposError: err instanceof Error ? err.message : "Failed to load repositories",
      });
    }
  },

  disconnect: () => {
    try {
      if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // 忽略存储异常
    }
    set({
      isConnected: false,
      isLoggedIn: false,
      token: null,
      repos: [],
      isReposLoading: false,
      reposError: null,
      profile: null,
      selectedYear: 2026,
      startMonth: 7,
      selectedMonth: "all",
      availableYears: [2026],
      yearsData: {},
      isLoading: false,
      error: null,
    });
  },

  refresh: async () => {
    const { profile, connect } = get();
    if (profile?.username) {
      await connect(profile.username);
    }
  },
}));

// 初始化后如果已连接，在后台静默刷新最新贡献日历与仓库列表
if (typeof window !== "undefined" && initial.isConnected && initial.profile?.username) {
  setTimeout(() => {
    void useGitHubActivityStore.getState().refresh();
    if (initial.isLoggedIn) {
      void useGitHubActivityStore.getState().fetchRepos();
    }
  }, 200);
}
