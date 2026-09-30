import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@zcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

const STARTUP_AGENT_WARMUP_LIMIT = 3;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

function resolveStartupAgentWarmupTargets(
  settings: Pick<ReturnType<typeof appSettingsSchema.parse>, "recentProjects">,
  activeTarget: StartupWorkspaceWarmupTarget,
): StartupWorkspaceWarmupTarget[] {
  const candidates: StartupWorkspaceWarmupTarget[] = [
    activeTarget,
    ...(settings.recentProjects ?? []).map((workspacePath) => ({
      workspacePath,
    })),
  ];
  const seen = new Set<string>();
  const targets: StartupWorkspaceWarmupTarget[] = [];

  for (const candidate of candidates) {
    const workspaceKey = candidate.workspaceIdentity?.trim() || candidate.workspacePath;
    if (!workspaceKey || seen.has(workspaceKey)) {
      continue;
    }
    seen.add(workspaceKey);
    targets.push(candidate);
    if (targets.length === STARTUP_AGENT_WARMUP_LIMIT) {
      break;
    }
  }

  return targets;
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // After the last activated workspace is moved or deleted, the Agent still needs to retain the original business path reading history.
      // However, the child process cwd must fall in a real directory; the conversation backing workspace only takes care of cwd.
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
      sessions,
      settings.lastActiveTabIndex,
    );
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // Passive sessions-index full recovery cannot start all workspaces, but only warms up the current one.
      // Users switching between recent projects re-assume a full cold start. Main fixedly selects the latest 3 at the unique startup boundary.
      // The Host still follows the original initializeWorkspace path; if it fails, it will not continue to scan the fourth padding bit.
      const agentWarmupTargets = resolveStartupAgentWarmupTargets(settings, {
        workspacePath: activeSession.workspacePath,
      });
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // The UI can have no items, but the Agent must always have the real cwd. Starting unified preheating for the first time
  // app-managed conversation backing workspace, ZCodeProject can no longer be created that could be mistaken for a project.
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
