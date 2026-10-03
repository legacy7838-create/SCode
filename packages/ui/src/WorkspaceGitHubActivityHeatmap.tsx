import React, { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  GITHUB_HEATMAP_LEVELS,
  type GitHubActivityWeek,
} from "@/store/githubActivityStore.js";

export interface WorkspaceGitHubActivityHeatmapProps {
  selectedYear: number;
  startMonth: number;
  selectedMonth: number | "all";
  availableYears: number[];
  visibleWeeks: GitHubActivityWeek[];
  visibleMonthSpans: Array<{ month: string; monthIndex: number; span: number }>;
  targetMonths: Set<number>;
  setSelectedYear: (year: number) => void;
  setSelectedMonth: (month: number | "all") => void;
}

export function WorkspaceGitHubActivityHeatmap({
  selectedYear,
  selectedMonth,
  availableYears,
  visibleWeeks,
  visibleMonthSpans,
  targetMonths,
  setSelectedYear,
  setSelectedMonth,
}: WorkspaceGitHubActivityHeatmapProps) {
  const [hoveredCell, setHoveredCell] = useState<{ date: string; count: number } | null>(null);

  return (
    <div className="rounded-lg border border-border/60 bg-surface/40 p-2">
      <div className="flex items-center justify-between gap-1.5">
        {/* 左侧：工作日标签 + 14 列热力方格 */}
        <div className="flex min-w-0">
          <div className="flex flex-col justify-between pt-3.5 pr-1 select-none font-medium h-[82px]">
            <span className="leading-none text-[9px] text-foreground-subtlest">Mon</span>
            <span className="leading-none text-[9px] text-foreground-subtlest">Wed</span>
            <span className="leading-none text-[9px] text-foreground-subtlest">Fri</span>
          </div>

          <div className="min-w-0 overflow-x-hidden">
            {/* 月份名称行 */}
            <div className="flex gap-[3px] min-w-max mb-1 h-3 text-ui-2xs text-foreground-subtlest select-none font-medium">
              {visibleMonthSpans.map((span) => {
                const isSelected = selectedMonth === span.monthIndex;
                return (
                  <div
                    key={span.month}
                    style={{ width: `${span.span * 13 - 3}px` }}
                    className={cn(
                      "text-left truncate cursor-pointer transition-colors text-[10px]",
                      isSelected
                        ? "text-primary font-semibold"
                        : "hover:text-foreground",
                    )}
                    onClick={() => {
                      setSelectedMonth(isSelected ? "all" : span.monthIndex);
                    }}
                    title={`Filter ${span.month}`}
                  >
                    {span.month}
                  </div>
                );
              })}
            </div>

            {/* 14 列 × 7 天方格（标准 10px 尺寸） */}
            <div className="flex gap-[3px]">
              {visibleWeeks.map((week) => (
                <div key={week.weekIndex} className="flex flex-col gap-[3px]">
                  {week.days.map((day) => {
                    const dt = new Date(day.date);
                    const inYear = dt.getUTCFullYear() === selectedYear;
                    const dayMonth = dt.getUTCMonth();
                    const inWindow = inYear && targetMonths.has(dayMonth);

                    if (!inWindow) {
                      return (
                        <div
                          key={day.date}
                          className="size-2.5 rounded-[2px] opacity-10 bg-surface border border-transparent pointer-events-none"
                        />
                      );
                    }

                    const isDimmed =
                      selectedMonth !== "all" && dayMonth !== selectedMonth;

                    return (
                      <div
                        key={day.date}
                        onMouseEnter={() =>
                          setHoveredCell({ date: day.date, count: day.count })
                        }
                        onMouseLeave={() => setHoveredCell(null)}
                        className={cn(
                          "size-2.5 rounded-[2px] transition-all cursor-pointer",
                          GITHUB_HEATMAP_LEVELS[day.level],
                          isDimmed ? "opacity-20 hover:opacity-100" : "hover:scale-125",
                        )}
                        title={`${day.count} contributions on ${day.date}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 垂直分割线 */}
        <div className="w-px h-[88px] bg-border/40 mx-0.5 shrink-0" />

        {/* 右侧内嵌年份按钮：应用 3px 极细迷你滚动条（消除 14px 粗滑块与上下箭头） */}
        <div className="flex flex-col gap-1 w-12 max-h-[88px] overflow-y-auto pr-0.5 shrink-0 zcode-mini-scrollbar">
          {availableYears.map((year) => (
            <button
              key={year}
              type="button"
              onClick={() => setSelectedYear(year)}
              className={cn(
                "w-full text-center py-0.5 px-1 rounded text-ui-2xs font-medium transition-colors text-[10px]",
                selectedYear === year
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      {/* 底部悬浮信息与图例 */}
      <div className="mt-2 flex items-center justify-between text-ui-2xs border-t border-border/40 pt-1 text-foreground-subtle">
        <span className="text-foreground-subtlest truncate text-[10px]">
          {hoveredCell
            ? `${hoveredCell.count} on ${hoveredCell.date}`
            : "Hover a cell for details"}
        </span>

        <div className="flex items-center gap-1 shrink-0 text-foreground-subtlest text-[9px]">
          <span>Less</span>
          {GITHUB_HEATMAP_LEVELS.map((colorClass, idx) => (
            <span
              key={idx}
              className={cn("size-2 rounded-[2px]", colorClass)}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
