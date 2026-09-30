// composer parity: `#` session candidate data source from old zcodeSessionStore/taskQueryCache/remote*
// The storefront cuts to v4 sessions-index (useWorkspaceSessionsIndexItems, the same source as the sidebar).
// The old storefront is no longer populated by the session list under the v4 shell. If you continue reading, you will get an empty panel; the serialization and sorting semantics remain unchanged.
// (collectSessionMentionItems is reserved for single testing and aggregation reuse).
import { useMemo } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { buildSessionMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import type { SessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import {
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  useWorkspaceSessionsIndexItems,
  type WorkspaceSessionsIndexScope,
} from "@/v4/useWorkspaceSessionsIndexItems.js";

const HASH_SESSION_MENTION_LIMIT_PER_WORKSPACE = 20;

interface SessionMentionItem extends MentionItem {
  /** Bucketing is only done in the candidate aggregation stage, no Lexical node or canonical mention is written. */
  workspaceKey: string;
}

function compareSessionTasks(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  currentWorkspaceKey?: string,
) {
  if (currentWorkspaceKey) {
    const leftCurrent =
      buildTaskWorkspaceKey(left.workspacePath, left.workspaceIdentity) === currentWorkspaceKey;
    const rightCurrent =
      buildTaskWorkspaceKey(right.workspacePath, right.workspaceIdentity) === currentWorkspaceKey;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
  }
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.title.localeCompare(right.title);
}

function getSessionLabel(task: ZCodeTaskMeta): string {
  const title = task.title.replace(/^#sess_[a-zA-Z0-9._-]+\s*/, "").trim();
  return title || "Untitled session";
}

function getWorkspaceLabel(task: ZCodeTaskMeta): string {
  const raw = task.workspacePath.trim() || task.workspaceIdentity?.trim() || "";
  return raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw;
}

function mapTaskToMentionItem(task: ZCodeTaskMeta, provider: ZCodeProvider): SessionMentionItem {
  const sessionId = task.taskId;
  const itemProvider = task.provider ?? provider;
  return {
    id: `session:${task.taskId}`,
    category: "sessions",
    label: getSessionLabel(task),
    description: getWorkspaceLabel(task),
    value: sessionId,
    markdown: buildSessionMentionMarkdown(sessionId, getSessionLabel(task)),
    keywords: [
      task.title,
      task.taskId,
      task.workspacePath,
      task.workspaceIdentity ?? "",
      task.model ?? "",
      itemProvider,
    ],
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  };
}

function collectSessionMentionItems(
  tasks: ZCodeTaskMeta[],
  provider: ZCodeProvider,
  options: {
    workspacePath?: string;
    workspaceIdentity?: string;
  } = {},
): SessionMentionItem[] {
  const currentWorkspaceKey = options.workspacePath
    ? buildTaskWorkspaceKey(options.workspacePath, options.workspaceIdentity)
    : undefined;
  const taskBySessionId = new Map<string, ZCodeTaskMeta>();
  for (const task of tasks) {
    if (task.migrationSource) {
      continue;
    }
    const sessionId = task.taskId;
    const current = taskBySessionId.get(sessionId);
    if (!current || task.updatedAt > current.updatedAt) {
      taskBySessionId.set(sessionId, task);
    }
  }

  return [...taskBySessionId.values()]
    .sort((left, right) => compareSessionTasks(left, right, currentWorkspaceKey))
    .map((task) => mapTaskToMentionItem(task, provider));
}

function limitSessionMentionItemsPerWorkspace(items: SessionMentionItem[]): SessionMentionItem[] {
  const itemCountByWorkspaceKey = new Map<string, number>();
  return items.filter((item) => {
    const itemCount = itemCountByWorkspaceKey.get(item.workspaceKey) ?? 0;
    if (itemCount >= HASH_SESSION_MENTION_LIMIT_PER_WORKSPACE) return false;
    itemCountByWorkspaceKey.set(item.workspaceKey, itemCount + 1);
    return true;
  });
}

function buildSessionMentionScopes(params: {
  baseServices: IServiceAccessor;
  currentRemoteSessionId: string | null;
  currentServices: IServiceAccessor;
  currentWorkspaceIdentity?: string;
  currentWorkspacePath: string;
  enabled: boolean;
  serviceResolverState: WorkspaceServiceResolverState;
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceSessionsIndexScope[] {
  if (!params.enabled) {
    return [];
  }

  const currentAgentService = params.currentServices.zcodeAgentService;
  const scopes: WorkspaceSessionsIndexScope[] = [];
  const seenWorkspaceKeys = new Set<string>();
  const candidates: Array<
    Pick<
      WorkspaceTabState,
      "remoteSessionId" | "remoteTarget" | "workspaceIdentity" | "workspacePath"
    >
  > = [
    {
      workspacePath: params.currentWorkspacePath,
      ...(params.currentWorkspaceIdentity
        ? { workspaceIdentity: params.currentWorkspaceIdentity }
        : {}),
      ...(params.currentRemoteSessionId ? { remoteSessionId: params.currentRemoteSessionId } : {}),
    },
    ...params.workspaceTabs,
  ];

  for (const candidate of candidates) {
    const workspaceKey = buildTaskWorkspaceKey(
      candidate.workspacePath,
      candidate.workspaceIdentity,
    );
    if (seenWorkspaceKeys.has(workspaceKey)) {
      continue;
    }

    const resolved = resolveWorkspaceServices(
      candidate,
      params.baseServices,
      params.serviceResolverState,
    );
    // Functional boundaries: # The reference is ultimately read by the current Agent Host's SQLite session store by session id.
    // Only the same agent service authority is aggregated here to avoid making another remote Host's session an optional but unreadable reference;
    // If the remote is not connected, null will be returned at the resolver, and it cannot fall back to the local base service.
    if (!resolved || resolved.services.zcodeAgentService !== currentAgentService) {
      continue;
    }

    seenWorkspaceKeys.add(workspaceKey);
    scopes.push({
      workspacePath: candidate.workspacePath,
      ...(candidate.workspaceIdentity ? { workspaceIdentity: candidate.workspaceIdentity } : {}),
      ...(resolved.remoteSessionId ? { endpointKey: resolved.remoteSessionId } : {}),
      agentService: resolved.services.zcodeAgentService,
    });
  }

  return scopes;
}

export function useSessionsMentionProvider(
  provider: ZCodeProvider,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  workspaceScope: SessionMentionWorkspaceScope,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const baseServices = useBaseWorkspaceServices();
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const {
    services: workspaceServices,
    remoteSessionId,
    isRemoteTarget,
  } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  // `@` and `#` reuse providers, but only `#` can be extended to the workspace of the same authority.
  // The sessions-index registry is still reused based on the endpoint+workspaceKey reference count, and no additional connections are established.
  const scopes = useMemo<WorkspaceSessionsIndexScope[]>(() => {
    if (!enabled || (isRemoteTarget && !remoteSessionId)) {
      return [];
    }
    if (workspaceScope === "current-workspace") {
      return [
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
          // The remote end must explicitly carry the service of the resolved endpoint, and the local Host cannot query the remote path.
          agentService: workspaceServices.zcodeAgentService,
        },
      ];
    }
    return buildSessionMentionScopes({
      baseServices,
      currentRemoteSessionId: remoteSessionId,
      currentServices: workspaceServices,
      currentWorkspaceIdentity: workspaceIdentity,
      currentWorkspacePath: workspacePath,
      enabled,
      serviceResolverState,
      workspaceTabs,
    });
  }, [
    baseServices,
    enabled,
    isRemoteTarget,
    remoteSessionId,
    serviceResolverState,
    workspaceIdentity,
    workspacePath,
    workspaceScope,
    workspaceServices,
    workspaceTabs,
  ]);
  const { items: indexMetas, hydratingEndpointKeys } = useWorkspaceSessionsIndexItems(scopes);

  const allItems = useMemo(
    () =>
      collectSessionMentionItems(indexMetas, provider, {
        workspacePath,
        workspaceIdentity,
      }),
    [indexMetas, provider, workspaceIdentity, workspacePath],
  );

  const items = useMemo(() => {
    // mention filter only sorts/intercepts the original object; retains the workspaceKey of SessionMentionItem.
    const matchedItems = filterMentionItemsWithOptions(allItems, query, {
      limit: Number.POSITIVE_INFINITY,
      requireQuery: false,
    }) as SessionMentionItem[];
    // `#` Search all sessions first, then limit the results independently by workspaceKey; cannot truncate globally.
    // Otherwise, the priority order of the current workspace will crowd out all other workspaces.
    return workspaceScope === "same-authority-workspaces"
      ? limitSessionMentionItemsPerWorkspace(matchedItems)
      : matchedItems;
  }, [allItems, query, workspaceScope]);

  return {
    items: enabled ? items : [],
    loading: enabled && hydratingEndpointKeys.length > 0,
    error: null,
    emptyText,
    title,
  };
}
