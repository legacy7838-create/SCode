/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";

// 插件设置页（marketplace / 安装管理）已下线；本组件只保留 MCP / Skills / Commands
// 三个独立能力分区各自的外壳（scope 选择 + 搜索 + 计数），不再承载 plugin tab。
export type CapabilityTabTarget = "mcps" | "skills" | "commands";

function getPathLeaf(workspacePath: string | null): string {
  if (!workspacePath) return "";
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: WorkspaceTabState };

interface PluginsSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  initialScopeKey?: string;
  mode: "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
}

function workspaceKey(tab: WorkspaceTabState): string {
  return getPluginWorkspaceKey(tab);
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}

export function PluginsSection({
  initialScopeKey,
  mode,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const tabs = useTabStore((state) => state.tabs);
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const workspaceTabs = useMemo(() => {
    const seen = new Set<string>();
    const scopedTabs = tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = workspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (
      activeWorkspacePath &&
      !activeWorkspaceIdentity?.trim() &&
      !scopedTabs.some(
        (tab) => workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
      )
    ) {
      // 启动恢复可能先恢复 activeWorkspacePath，再异步补齐 tabs；此时不能把
      // Workspace 配置范围误显示成不可用，否则用户无法读取/修改项目配置。
      scopedTabs.push({
        id: `__active_workspace__:${activeWorkspaceIdentity?.trim() || activeWorkspacePath}`,
        kind: "workspace",
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        label: getPathLeaf(activeWorkspacePath) || activeWorkspacePath,
      });
    }
    return scopedTabs;
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabs]);
  const preferredHost = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""),
      ) ??
      workspaceTabs[0] ??
      null,
    [activeWorkspaceIdentity, activeWorkspacePath, workspaceTabs],
  );
  const [pickedScopeKey, setPickedScopeKey] = useState(() => initialScopeKey?.trim() || "user");
  const selectedScopeKey = pickedScopeKey;
  const selectedTab: CapabilityTabTarget =
    mode === "mcp" ? "mcps" : mode === "skill" ? "skills" : "commands";
  useEffect(() => {
    setPickedScopeKey(initialScopeKey?.trim() || "user");
  }, [initialScopeKey]);
  const [searchQueries, setSearchQueries] = useState<Record<CapabilityTabTarget, string>>({
    mcps: "",
    skills: "",
    commands: "",
  });
  const [capabilityCounts, setCapabilityCounts] = useState<Record<CapabilityTabTarget, number>>({
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  const activeSearchQuery = searchQueries[selectedTab];
  const selectedScope: PluginScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => workspaceKey(candidate) === selectedScopeKey);
    return tab ? { kind: "workspace", key: workspaceKey(tab), tab } : { kind: "user", key: "user" };
  }, [selectedScopeKey, workspaceTabs]);
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : preferredHost;
  const effectiveMcpScopeKey =
    mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : selectedScopeKey;
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? preferredHost);
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : selectedScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? preferredHost);

  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  useEffect(() => {
    if (
      pickedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => workspaceKey(tab) === pickedScopeKey)
    ) {
      // 记录的是具体 workspace identity；目标已关闭或断连时，静默选中 User 会让
      // 用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
      setPickedScopeKey("user");
      toast(
        intl.formatMessage({
          id: "settings.plugin.scopeUnavailableFallback",
        }),
      );
    }
  }, [intl, pickedScopeKey, workspaceTabs]);
  const selectedTargetKey = target ? workspaceKey(target) : "";
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);

  return (
    <div className="space-y-6">
      <Tabs value={selectedTab}>
        {!mcpEditorOpen && !commandEditorOpen ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <PluginScopeMenu
                align="start"
                selectedScopeKey={selectedScopeKey}
                triggerTestId="plugin-settings-scope-trigger"
                userOptionTestId="plugin-settings-scope-user-option"
                workspaceOptionTestIdPrefix="plugin-settings-scope-option"
                workspaceTabs={workspaceTabs}
                onScopeKeyChange={setPickedScopeKey}
              />
              <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
              <div
                data-independent-capability-count="true"
                className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
              >
                <span>
                  {intl.formatMessage({
                    id:
                      mode === "mcp"
                        ? "settings.plugin.tab.mcps"
                        : mode === "skill"
                          ? "settings.plugin.tab.skills"
                          : "settings.plugin.tab.commands",
                  })}
                </span>
                <span className="text-ui-sm text-foreground-subtle">
                  {mode === "mcp"
                    ? capabilityCounts.mcps
                    : mode === "skill"
                      ? capabilityCounts.skills
                      : capabilityCounts.commands}
                </span>
              </div>
            </div>
            <SettingsSearchInput
              data-testid="plugin-settings-search"
              containerClassName="w-full sm:ml-auto sm:w-64"
              clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
              value={activeSearchQuery}
              onClear={() => {
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: "",
                }));
              }}
              onChange={(event) => {
                const value = event.target.value;
                setSearchQueries((current) => ({
                  ...current,
                  [selectedTab]: value,
                }));
              }}
              placeholder={intl.formatMessage({
                id:
                  selectedTab === "mcps"
                    ? "settings.mcp.searchPlaceholder"
                    : selectedTab === "skills"
                      ? "settings.skills.searchPlaceholder"
                      : "settings.commands.searchPlaceholder",
              })}
            />
          </div>
        ) : null}
        {mode === "mcp" ? (
          <TabsContent
            forceMount
            value="mcps"
            className={
              mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {mcpTarget ? (
              <McpSettingsSection
                workspacePath={mcpTarget.workspacePath}
                workspaceIdentity={mcpTarget.workspaceIdentity}
                remoteSessionId={mcpTarget.remoteSessionId}
                remoteTarget={mcpTarget.remoteTarget}
                localWorkspacePath={mcpTarget.localWorkspacePath}
                scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.mcps}
                onVisibleCountChange={updateMcpCount}
                onEditorOpenChange={handleMcpEditorOpenChange}
                onFormScopeKeyChange={setMcpFormScopeKey}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "skill" ? (
          <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
            {target ? (
              <SkillsSection
                workspacePath={target.workspacePath}
                workspaceIdentity={target.workspaceIdentity}
                remoteSessionId={target.remoteSessionId}
                remoteTarget={target.remoteTarget}
                scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                searchQuery={searchQueries.skills}
                onCreateTask={onCreateTask}
                onVisibleCountChange={updateSkillCount}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
        {mode === "command" ? (
          <TabsContent
            forceMount
            value="commands"
            className={
              commandEditorOpen
                ? "data-[state=inactive]:hidden"
                : "mt-6 data-[state=inactive]:hidden"
            }
          >
            {commandTarget ? (
              <CommandsSection
                workspacePath={commandTarget.workspacePath}
                workspaceIdentity={commandTarget.workspaceIdentity}
                scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                parentScopeKey={selectedScopeKey}
                workspaceTabs={workspaceTabs}
                searchQuery={searchQueries.commands}
                onVisibleCountChange={updateCommandCount}
                onEditorOpenChange={setCommandEditorOpen}
                onFormScopeKeyChange={setCommandFormScopeKey}
              />
            ) : (
              <EmptyState
                message={intl.formatMessage({
                  id: "settings.plugin.noWorkspace",
                })}
              />
            )}
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
