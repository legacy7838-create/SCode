export interface GitHubCommitItem {
  id: string;
  message: string;
  repo: string;
  date: string; // ISO string
  year: number;
  month: number; // 0-11
}

export interface GitHubActivityDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface GitHubActivityWeek {
  weekIndex: number;
  days: GitHubActivityDay[];
  monthLabel?: string;
}

export interface MonthSpan {
  month: string;
  startWeek: number;
  span: number;
}

export interface GitHubUserProfile {
  username: string;
  name?: string;
  avatarUrl?: string;
  bio?: string;
  publicRepos?: number;
  totalContributions: number;
}

export interface YearActivityData {
  year: number;
  totalCount: number;
  weeks: GitHubActivityWeek[];
  monthSpans: MonthSpan[];
  commits: GitHubCommitItem[];
}

export interface GitHubActivityState {
  isConnected: boolean;
  isLoggedIn: boolean;
  token: string | null;
  repos: GitHubRepoItem[];
  isReposLoading: boolean;
  reposError: string | null;
  profile: GitHubUserProfile | null;
  selectedYear: number;
  startMonth: number; // 0-9 (表示 3 个月窗口的起始月，例如 7 表示 Aug..Oct)
  selectedMonth: number | "all";
  availableYears: number[];
  yearsData: Record<number, YearActivityData>;
  isLoading: boolean;
  error: string | null;

  setSelectedYear: (year: number) => void;
  setStartMonth: (month: number) => void;
  setSelectedMonth: (month: number | "all") => void;
  prevWindow: () => void;
  nextWindow: () => void;
  connect: (username: string) => Promise<void>;
  disconnect: () => void;
  login: (token?: string) => Promise<void>;
  logout: () => void;
  fetchRepos: () => Promise<void>;
  refresh: () => Promise<void>;
}

export interface GitHubRepoItem {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
  isFork: boolean;
  stargazersCount: number;
  forksCount: number;
  language: string | null;
  updatedAt: string;
  defaultBranch: string;
  topics?: string[];
}

export const STORAGE_KEY = "zcode_github_activity_session";
export const DAY_MS = 86_400_000;
export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

// GitHub 官方标准贡献色阶（暗色与亮色适配）
export const GITHUB_HEATMAP_LEVELS = [
  "bg-surface border-border/50 dark:bg-[#161b22] dark:border-[#1b1f24]",
  "bg-[#9be9a8] border-[#82d68f] dark:bg-[#0e4429] dark:border-[#0e4429]",
  "bg-[#40c463] border-[#34ab54] dark:bg-[#006d32] dark:border-[#006d32]",
  "bg-[#30a14e] border-[#25873f] dark:bg-[#26a641] dark:border-[#26a641]",
  "bg-[#216e39] border-[#18552b] dark:bg-[#39d353] dark:border-[#39d353]",
];
