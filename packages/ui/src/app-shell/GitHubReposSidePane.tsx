import React, { useState, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GithubIcon,
  Search01Icon,
  RefreshCwIcon,
  ExternalLinkIcon,
  Copy01Icon,
  Tick02Icon,
  GitForkIcon,
  StarIcon,
  Cancel01Icon,
  LockIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useGitHubActivityStore, type GitHubRepoItem } from "@/store/githubActivityStore.js";
import { toast } from "@/components/ui/toast.js";

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  React: "#61dafb",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Java: "#b07219",
  Shell: "#89e051",
  PHP: "#4F5D95",
  Ruby: "#701516",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Dart: "#00B4AB",
};

function formatRelativeTime(dateStr: string): string {
  try {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffYears > 0) return `${diffYears}y ago`;
    if (diffMonths > 0) return `${diffMonths}mo ago`;
    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMin > 0) return `${diffMin}m ago`;
    return "just now";
  } catch {
    return dateStr.slice(0, 10);
  }
}

export function GitHubReposSidePane({ onClose }: { onClose?: () => void }) {
  const { profile, repos, isReposLoading, reposError, fetchRepos } = useGitHubActivityStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "sources" | "private" | "forks">("all");
  const [sortBy, setSortBy] = useState<"updated" | "stars" | "name">("updated");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleCopyClone = (repo: GitHubRepoItem) => {
    const cloneCmd = `git clone ${repo.cloneUrl}`;
    void navigator.clipboard.writeText(cloneCmd).then(() => {
      setCopiedId(repo.id);
      toast("Clone command copied to clipboard!");
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const filteredRepos = useMemo(() => {
    let result = [...repos];

    // 类型过滤
    if (filterType === "sources") {
      result = result.filter((r) => !r.isFork);
    } else if (filterType === "private") {
      result = result.filter((r) => r.isPrivate);
    } else if (filterType === "forks") {
      result = result.filter((r) => r.isFork);
    }

    // 搜索过滤
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q) ||
          r.language?.toLowerCase().includes(q) ||
          r.topics?.some((t) => t.toLowerCase().includes(q)),
      );
    }

    // 排序
    result.sort((a, b) => {
      if (sortBy === "stars") return b.stargazersCount - a.stargazersCount;
      if (sortBy === "name") return a.name.localeCompare(b.name);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return result;
  }, [repos, filterType, searchQuery, sortBy]);

  return (
    <div className="flex h-full flex-col bg-background select-none">
      {/* 顶部标题栏与用户信息 */}
      <div className="flex items-center justify-between border-b border-border/70 px-3.5 py-2.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex size-7 items-center justify-center rounded-lg bg-surface border border-border shrink-0">
            <HugeiconsIcon icon={GithubIcon} size={16} className="text-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-ui-base font-semibold text-foreground truncate">
                GitHub Repositories
              </h3>
              {profile?.username ? (
                <a
                  href={`https://github.com/${profile.username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-ui-xs text-primary hover:underline"
                  title="Open GitHub Profile"
                >
                  <span>@{profile.username}</span>
                  <HugeiconsIcon icon={ExternalLinkIcon} size={11} />
                </a>
              ) : null}
            </div>
            <p className="text-ui-2xs text-foreground-subtle truncate">
              {repos.length} {repos.length === 1 ? "repository" : "repositories"} found
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => void fetchRepos()}
            disabled={isReposLoading}
            title="Refresh repository list"
            className="size-6 text-foreground-subtle hover:text-foreground"
          >
            <HugeiconsIcon
              icon={RefreshCwIcon}
              size={13}
              className={cn(isReposLoading && "animate-spin")}
            />
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              title="Close panel"
              className="size-6 text-foreground-subtle hover:text-foreground"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} />
            </Button>
          ) : null}
        </div>
      </div>

      {/* 搜索与过滤工具栏 */}
      <div className="flex flex-col gap-2 border-b border-border/60 p-3 shrink-0 bg-surface/30">
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-subtlest pointer-events-none"
          />
          <Input
            type="text"
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-ui-xs"
          />
        </div>

        <div className="flex items-center justify-between gap-2 text-ui-2xs">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setFilterType("all")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                filterType === "all"
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover",
              )}
            >
              All ({repos.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType("sources")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                filterType === "sources"
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover",
              )}
            >
              Sources ({repos.filter((r) => !r.isFork).length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType("private")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                filterType === "private"
                  ? "bg-selected text-amber-500 font-semibold"
                  : "text-foreground-subtle hover:bg-hover",
              )}
            >
              Private ({repos.filter((r) => r.isPrivate).length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType("forks")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                filterType === "forks"
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover",
              )}
            >
              Forks ({repos.filter((r) => r.isFork).length})
            </button>
          </div>

          <div className="flex items-center gap-1 text-foreground-subtlest">
            <span>Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "updated" | "stars" | "name")}
              className="bg-transparent text-foreground-subtle hover:text-foreground outline-none text-ui-2xs font-medium cursor-pointer"
            >
              <option value="updated">Updated</option>
              <option value="stars">Stars</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
      </div>

      {/* 仓库列表容器 */}
      <div className="flex-1 overflow-y-auto zcode-mini-scrollbar p-3 space-y-2">
        {isReposLoading && repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-foreground-subtle">
            <HugeiconsIcon icon={RefreshCwIcon} size={20} className="animate-spin mb-2" />
            <p className="text-ui-xs">Loading repositories...</p>
          </div>
        ) : reposError ? (
          <div className="flex flex-col items-center justify-center h-48 text-center p-4">
            <p className="text-ui-xs text-destructive mb-2">{reposError}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void fetchRepos()}
              className="text-ui-2xs"
            >
              Retry
            </Button>
          </div>
        ) : filteredRepos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-foreground-subtle">
            <p className="text-ui-xs">No repositories match your criteria</p>
          </div>
        ) : (
          filteredRepos.map((repo) => {
            const langColor =
              (repo.language && LANGUAGE_COLORS[repo.language]) || "var(--color-neutral-400)";
            const isCopied = copiedId === repo.id;

            return (
              <div
                key={repo.id}
                className="group flex flex-col gap-1.5 rounded-lg border border-border/70 bg-surface/40 p-2.5 hover:border-border hover:bg-surface/80 transition-colors"
              >
                {/* 仓库名称与外部链接 */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ui-sm font-semibold text-primary hover:underline truncate"
                        title={repo.fullName}
                      >
                        {repo.name}
                      </a>
                      {repo.isPrivate ? (
                        <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-500">
                          <HugeiconsIcon icon={LockIcon} size={9} />
                          Private
                        </span>
                      ) : (
                        <span className="rounded-full border border-border/60 bg-surface px-1.5 py-0 text-[10px] font-medium text-foreground-subtle">
                          {repo.isFork ? "Fork" : "Public"}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 快捷操作 */}
                  <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => handleCopyClone(repo)}
                      title="Copy clone command"
                      className="flex size-5.5 items-center justify-center rounded hover:bg-hover text-foreground-subtle hover:text-foreground"
                    >
                      <HugeiconsIcon
                        icon={isCopied ? Tick02Icon : Copy01Icon}
                        size={12}
                        className={cn(isCopied && "text-emerald-500")}
                      />
                    </button>
                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open on GitHub"
                      className="flex size-5.5 items-center justify-center rounded hover:bg-hover text-foreground-subtle hover:text-foreground"
                    >
                      <HugeiconsIcon icon={ExternalLinkIcon} size={12} />
                    </a>
                  </div>
                </div>

                {/* 仓库描述 */}
                {repo.description ? (
                  <p className="text-ui-xs text-foreground-subtle line-clamp-2 leading-relaxed">
                    {repo.description}
                  </p>
                ) : null}

                {/* 底部元信息：语言、Stars、Forks、更新时间 */}
                <div className="flex items-center gap-3 text-[11px] text-foreground-subtlest pt-1 border-t border-border/40">
                  {repo.language ? (
                    <div className="flex items-center gap-1">
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{ backgroundColor: langColor }}
                      />
                      <span>{repo.language}</span>
                    </div>
                  ) : null}

                  {repo.stargazersCount > 0 ? (
                    <div className="flex items-center gap-0.5 text-foreground-subtle">
                      <HugeiconsIcon icon={StarIcon} size={11} className="text-amber-500" />
                      <span>{repo.stargazersCount}</span>
                    </div>
                  ) : null}

                  {repo.forksCount > 0 ? (
                    <div className="flex items-center gap-0.5">
                      <HugeiconsIcon icon={GitForkIcon} size={11} />
                      <span>{repo.forksCount}</span>
                    </div>
                  ) : null}

                  <span className="ml-auto">{formatRelativeTime(repo.updatedAt)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
