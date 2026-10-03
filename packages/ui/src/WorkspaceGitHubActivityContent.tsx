import React, { useState, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GithubIcon,
  ExternalLinkIcon,
  Cancel01Icon,
  Login01Icon,
  Logout01Icon,
  RefreshCwIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  useGitHubActivityStore,
  MONTH_NAMES,
} from "@/store/githubActivityStore.js";
import { useGitHubReposStore } from "@/store/githubReposStore.js";
import { WorkspaceGitHubConnectForm } from "@/WorkspaceGitHubConnectForm.js";
import { WorkspaceGitHubActivityHeatmap } from "@/WorkspaceGitHubActivityHeatmap.js";
import { WorkspaceGitHubLoginDialog } from "@/WorkspaceGitHubLoginDialog.js";

/**
 * 修复说明（中）：
 * 1. 恢复用户认可的原版 Short UI 布局（10px 标准方块、清晰易读的字号与间距、右对齐月份箭头导航）。
 * 2. 隐藏粗大原生滚动条滑块，同时保留鼠标滚轮/触控板自然平滑滚动。
 * 3. 在断开连接按钮旁添加 Login 登录按钮；登录后自动显示箭头按钮（ArrowRight01Icon），点击后自动展开侧边栏展示仓库列表。
 * 4. 支持 Popover 受控关闭：提供专门的 cross 叉号按钮（Cancel01Icon），而将断开连接区分使用 Logout01Icon，
 *    解决原 HoverCard 鼠标移走即意外关闭的问题，保证只有点击切换按钮或关闭叉号时才退出展示。
 */
export function WorkspaceGitHubActivityContent({ onClose }: { onClose?: () => void } = {}) {
  const {
    isConnected,
    isLoggedIn,
    profile,
    selectedYear,
    startMonth,
    selectedMonth,
    availableYears,
    yearsData,
    isLoading,
    setSelectedYear,
    setSelectedMonth,
    prevWindow,
    nextWindow,
    token,
    disconnect,
    refresh,
  } = useGitHubActivityStore();

  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false);

  const handleOpenRepos = () => {
    useGitHubReposStore.getState().requestOpen();
  };

  const activeYearData = yearsData[selectedYear] ?? {
    year: selectedYear,
    totalCount: 0,
    weeks: [],
    monthSpans: [],
    commits: [],
  };

  const targetMonths = useMemo(
    () => new Set([startMonth, startMonth + 1, startMonth + 2]),
    [startMonth],
  );

  // 筛选出属于这 3 个月的周（约 14 列）
  const visibleWeeks = useMemo(() => {
    return activeYearData.weeks.filter((w) =>
      w.days.some((d) => {
        const dt = new Date(d.date);
        return dt.getUTCFullYear() === selectedYear && targetMonths.has(dt.getUTCMonth());
      }),
    );
  }, [activeYearData.weeks, selectedYear, targetMonths]);

  // 计算这 3 个月在 14 列中的自适应宽度与起始偏移
  const visibleMonthSpans = useMemo(() => {
    const months = [startMonth, startMonth + 1, startMonth + 2];
    const spans: Array<{ month: string; monthIndex: number; span: number }> = [];

    for (let i = 0; i < months.length; i++) {
      const m = months[i]!;
      const startIdx = visibleWeeks.findIndex((w) =>
        w.days.some((d) => {
          const dt = new Date(d.date);
          return dt.getUTCFullYear() === selectedYear && dt.getUTCMonth() === m;
        }),
      );
      if (startIdx === -1) continue;

      const nextIdx =
        i === months.length - 1
          ? visibleWeeks.length
          : visibleWeeks.findIndex((w) =>
              w.days.some((d) => {
                const dt = new Date(d.date);
                return dt.getUTCFullYear() === selectedYear && dt.getUTCMonth() === months[i + 1];
              }),
            );

      const span = Math.max(1, (nextIdx === -1 ? visibleWeeks.length : nextIdx) - startIdx);
      spans.push({
        month: MONTH_NAMES[m] ?? "",
        monthIndex: m,
        span,
      });
    }

    return spans;
  }, [startMonth, selectedYear, visibleWeeks]);

  // 计算所选 3 个月或具体月份的贡献总和
  const displayContributionsCount = useMemo(() => {
    return visibleWeeks.reduce((acc, week) => {
      return (
        acc +
        week.days.reduce((wSum, d) => {
          const dt = new Date(d.date);
          const inYear = dt.getUTCFullYear() === selectedYear;
          const dMonth = dt.getUTCMonth();
          if (!inYear) return wSum;

          if (selectedMonth === "all") {
            return targetMonths.has(dMonth) ? wSum + d.count : wSum;
          }
          return dMonth === selectedMonth ? wSum + d.count : wSum;
        }, 0)
      );
    }, 0);
  }, [visibleWeeks, selectedYear, selectedMonth, targetMonths]);

  // 判断是否已到达最早或最新年份边界
  const currentYearIdx = availableYears.indexOf(selectedYear);
  const isAtOldestBoundary =
    startMonth === 0 && currentYearIdx === availableYears.length - 1;
  const isAtNewestBoundary =
    startMonth === 9 && currentYearIdx === 0;

  if (!isConnected) {
    return <WorkspaceGitHubConnectForm onClose={onClose} />;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 transition-opacity duration-150",
        isLoginDialogOpen && "opacity-20 pointer-events-none select-none",
      )}
    >
      {/* 顶栏：头像、用户名、总体年度贡献、刷新与断开 */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={profile.username}
              className="size-6 rounded-full border border-border object-cover shrink-0"
            />
          ) : (
            <div className="flex size-6 items-center justify-center rounded-full bg-surface border border-border shrink-0">
              <HugeiconsIcon icon={GithubIcon} size={14} />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="truncate text-ui-xs font-semibold text-foreground">
                {profile?.name || profile?.username}
              </span>
              <a
                href={`https://github.com/${profile?.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground-subtle hover:text-foreground inline-flex items-center"
                title="Open GitHub Profile"
              >
                <HugeiconsIcon icon={ExternalLinkIcon} size={11} />
              </a>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => void refresh()}
            disabled={isLoading}
            title="Refresh activity"
            className="size-5.5 text-foreground-subtle hover:text-foreground"
          >
            <HugeiconsIcon
              icon={RefreshCwIcon}
              size={11}
              className={cn(isLoading && "animate-spin")}
            />
          </Button>

          {/* 优化 Login 与 Repos 按钮：圆润胶囊样式、集成图标、轻柔半透背景，避免原粗糙方框白边 */}
          {!isLoggedIn ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setIsLoginDialogOpen(true)}
              title="Log in with GitHub Token to access private repositories & contributions"
              className="h-5.5 px-2 rounded-full bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-ui-2xs font-semibold inline-flex items-center gap-1 shadow-2xs transition-all active:scale-95"
            >
              <HugeiconsIcon icon={Login01Icon} size={11} strokeWidth={2} />
              <span>Login</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleOpenRepos}
              title={
                token
                  ? "Open GitHub Repositories (Private Access Active)"
                  : "Open GitHub Repositories in Side Panel"
              }
              className="h-5.5 px-2 rounded-full bg-primary/15 hover:bg-primary/25 text-primary border border-primary/30 text-ui-2xs font-semibold inline-flex items-center gap-1 shadow-2xs transition-all active:scale-95"
            >
              <span>Repos</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={2.5} />
            </Button>
          )}

          <div className="h-3 w-px bg-border/60 mx-0.5" />

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={disconnect}
            title="Disconnect account"
            className="size-5.5 text-foreground-subtle hover:text-destructive"
          >
            <HugeiconsIcon icon={Logout01Icon} size={11} />
          </Button>

          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              title="Close"
              className="size-5.5 text-foreground-subtle hover:text-foreground"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} />
            </Button>
          )}
        </div>
      </div>

      {/* 3 个月窗口导航条：左侧当期贡献数，右侧左右箭头切换月份 */}
      <div className="flex items-center justify-between text-ui-xs px-0.5">
        <span className="text-ui-2xs font-medium text-foreground-subtle">
          <strong className="text-foreground font-semibold">
            {displayContributionsCount}
          </strong>{" "}
          contributions
        </span>

        {/* 右对齐的月份与左右箭头 */}
        <div className="flex items-center gap-0.5 font-medium text-foreground ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={prevWindow}
            disabled={isAtOldestBoundary}
            title="Previous month"
            className="size-5 rounded text-foreground-subtle hover:text-foreground disabled:opacity-25"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={13} />
          </Button>
          <span className="text-ui-2xs font-semibold text-foreground select-none px-1 whitespace-nowrap">
            {MONTH_NAMES[startMonth]} – {MONTH_NAMES[startMonth + 2]} {selectedYear}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={nextWindow}
            disabled={isAtNewestBoundary}
            title="Next month"
            className="size-5 rounded text-foreground-subtle hover:text-foreground disabled:opacity-25"
          >
            <HugeiconsIcon icon={ArrowRight01Icon} size={13} />
          </Button>
        </div>
      </div>

      {/* 主热力图卡片 */}
      <WorkspaceGitHubActivityHeatmap
        selectedYear={selectedYear}
        startMonth={startMonth}
        selectedMonth={selectedMonth}
        availableYears={availableYears}
        visibleWeeks={visibleWeeks}
        visibleMonthSpans={visibleMonthSpans}
        targetMonths={targetMonths}
        setSelectedYear={setSelectedYear}
        setSelectedMonth={setSelectedMonth}
      />

      <WorkspaceGitHubLoginDialog
        isOpen={isLoginDialogOpen}
        onClose={() => setIsLoginDialogOpen(false)}
      />
    </div>
  );
}
