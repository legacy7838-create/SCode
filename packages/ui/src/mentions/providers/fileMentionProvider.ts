import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

function mapWorkspaceFileToMentionItem(entry: WorkspaceFileEntry): MentionItem {
  return {
    id: `file:${entry.relativePath}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: entry.relativePath,
    // The standard translation format of file mention needs to maintain `[filename](path)`,
    // Previously, the entire relativePath was mistakenly regarded as the link text, causing the echo and copy content to degenerate into "long path as title" after sending.
    // Here we revert to using only basename as the label, and the path is only placed in the link target, consistent with the input box node style.
    markdown: buildFileMentionMarkdown(entry.relativePath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
): MentionCategoryResult {
  const { fileService } = useServices();
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // The connection instance also belongs to the scope: remote reconnection with the same path cannot accept the query results of the old Host.
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: WorkspaceFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // The error state waits for the panel/workspace/connection life cycle to be reset to avoid query changes triggering a failed retry loop.
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true, error: null });
    const params = { rootPath: workspacePath, workspaceIdentity, query, limit };
    const search = async () => {
      try {
        let entries = await fileService.searchWorkspaceFiles(params);
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(query);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // No-hit catch-up scans must bypass the Host TTL, otherwise new external files will never be visible during the cache lifetime.
          entries = await fileService.searchWorkspaceFiles({ ...params, refresh: true });
          if (!active) return;
        }
        setResult({ scope, query, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, entries: [], loading: false, error: scope.error });
      }
    };
    void search();
    // Query, workspace, connection, or panel lifecycle changes invalidate issued asynchronous responses.
    return () => {
      active = false;
    };
  }, [enabled, fileService, workspacePath, workspaceIdentity, query, limit, scope]);

  const current =
    enabled && result?.scope === scope && result.query === query && result.limit === limit;
  const items = useMemo(
    () => (current ? result.entries.map(mapWorkspaceFileToMentionItem) : []),
    [current, result],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
