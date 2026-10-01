/* eslint-disable max-lines -- there are many remote connection fields; the SSH/WSL branches are
 * still maintained together in a single file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
} from "@zcode/shared";
import { ChevronDownIcon, Plus } from "lucide-react";
import {
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
} from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

export function RemoteConnectionFields({
  kind,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  remoteWorkspaceSessions = [],
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
}: {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [sshAliasPopoverOpen, setSshAliasPopoverOpen] = useState(false);
  const sshAliasListRef = useRef<HTMLDivElement | null>(null);
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));
  const handleSshAliasListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // When the Popover is embedded in the Dialog, the outer scroll lock will swallow the default scroll wheel behavior.
    // As a result, alias CommandList can only drag the scroll bar and cannot scroll directly with the wheel.
    // Here, we explicitly drive the scrollTop of the list itself to ensure that both the mouse wheel and the trackpad can scroll the candidates.
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (kind !== "ssh" && sshAliasPopoverOpen) {
      setSshAliasPopoverOpen(false);
    }
  }, [kind, sshAliasPopoverOpen]);

  useEffect(() => {
    if (!sshAliasPopoverOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedAliasItem = sshAliasListRef.current?.querySelector<HTMLElement>(
        '[data-ssh-config-alias-selected="true"]',
      );
      selectedAliasItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [sshAliasPopoverOpen, selectedSshConfigAlias, sshConfigAliases.length]);

  switch (kind) {
    case "ssh":
      return (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.configAlias" })}
            </label>
            <Popover open={sshAliasPopoverOpen} onOpenChange={setSshAliasPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={sshConfigAliasesLoading || sshConfigAliases.length === 0}
                  data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
                  className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
                >
                  <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
                  <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-80 gap-0 bg-menu p-0">
                <Command className="bg-transparent p-0 text-foreground">
                  <CommandInput
                    placeholder={intl.formatMessage({
                      id: "ssh.configAliasSearchPlaceholder",
                    })}
                    className="h-8"
                  />
                  <CommandList
                    ref={sshAliasListRef}
                    className="max-h-60 overscroll-contain"
                    onWheel={handleSshAliasListWheel}
                  >
                    <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
                    </CommandEmpty>
                    <CommandGroup className="p-1">
                      <CommandItem
                        value={NO_SSH_CONFIG_ALIAS_VALUE}
                        data-checked={selectedSshConfigAlias == null ? "true" : undefined}
                        data-ssh-config-alias-selected={
                          selectedSshConfigAlias == null ? "true" : undefined
                        }
                        className="min-h-8 cursor-pointer px-2 text-ui-base"
                        onSelect={() => {
                          clearSelectedSshConfigAlias();
                          setSshAliasPopoverOpen(false);
                        }}
                      >
                        <span className="truncate">
                          {intl.formatMessage({ id: "ssh.configAliasPlaceholder" })}
                        </span>
                      </CommandItem>
                      {sshConfigAliases.map((aliasOption) => (
                        <CommandItem
                          key={aliasOption.alias}
                          value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                          data-checked={
                            selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                          }
                          data-ssh-config-alias-selected={
                            selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                          }
                          className="min-h-8 cursor-pointer px-2 text-ui-base"
                          onSelect={() => {
                            applySshConfigAlias(aliasOption);
                            setSshAliasPopoverOpen(false);
                          }}
                        >
                          <span className="flex min-w-0 flex-1 flex-col text-left">
                            <span className="truncate">{aliasOption.alias}</span>
                            <span className="truncate text-ui-base text-foreground-subtle">
                              {formatSshConfigAliasSummary(aliasOption)}
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p
              className={cn(
                "text-ui-base",
                sshConfigAliasesError ? "text-warning" : "text-foreground-subtle",
              )}
            >
              {sshConfigAliasesLoading
                ? intl.formatMessage({ id: "common.loading" })
                : sshConfigAliasesError
                  ? intl.formatMessage({ id: "ssh.configAliasLoadFailed" })
                  : sshConfigAliases.length === 0
                    ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
                    : intl.formatMessage({ id: "ssh.configAliasDescription" })}
            </p>
          </div>

          {/* Electron / Chromium's native autocomplete is unreliable in the SSH wizard,
              and default values (such as localhost / 22) filter the history candidates prematurely.
              Instead we use explicit candidates drawn from the app's own persisted remote
              connection history, showing the full history on focus; passwords still never take part
              in history backfill.
              */}
          {/*
              The suggestion list used to expand right after the full-width input, which turned into
              a long strip inside large dialogs. Here the width is limited to what the field
              actually means: only the suggestion list narrows, the original input layout is
              unchanged.
              */}
          {/*
              Using an example value directly as the placeholder makes it look like a default is
              already filled in. We use a "hint + example" instead, so users know they still have to
              fill in the required fields themselves.
              */}
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem]">
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.host" })}
              value={host}
              onChange={setHost}
              placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
              suggestions={sshHistorySuggestions.hosts}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_HOST_INPUT}
            />
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.port" })}
              value={port}
              onChange={setPort}
              placeholder="22"
              suggestions={sshHistorySuggestions.ports}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(8ch, calc(100vw - 2rem))"
              inputMode="numeric"
              data-testid={TID_SSH_PORT_INPUT}
            />
          </div>

          {/*
              The auth method used to reuse the port field's 6.5rem narrow column, and after
              subtracting padding the two options squeezed the mixed Chinese/English labels into
              wrapping or overflow. Here the auth method gets its own 12rem, and option labels are
              forbidden from wrapping.
              */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <RemoteConnectionHistoryInput
              className="h-9 text-ui-base"
              label={intl.formatMessage({ id: "ssh.username" })}
              value={username}
              onChange={setUsername}
              placeholder={intl.formatMessage({ id: "ssh.usernamePlaceholder" })}
              suggestions={sshHistorySuggestions.usernames}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_USERNAME_INPUT}
            />

            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.authMethod" })}
              </label>
              <div className="inline-flex w-full items-center rounded-lg border border-input-border bg-input p-[3px]">
                {(["password", "privateKey"] as const).map((value) => {
                  const selected = sshAuthMethod === value;

                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSshAuthMethod(value)}
                      data-testid={
                        value === "password" ? TID_SSH_AUTH_PASSWORD : TID_SSH_AUTH_PRIVATE_KEY
                      }
                      className={cn(
                        "inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-ui-base font-medium whitespace-nowrap transition-colors",
                        selected
                          ? "bg-background text-foreground"
                          : "text-foreground-subtle hover:text-foreground",
                      )}
                    >
                      {intl.formatMessage({ id: `ssh.auth.${value}` })}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {sshAuthMethod === "password" ? (
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.password" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={intl.formatMessage({
                  id: "ssh.passwordPlaceholder",
                })}
                name="remote-ssh-password"
                autoComplete="off"
                data-testid={TID_SSH_PASSWORD_INPUT}
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.privateKey" })}
              </label>
              <div className="relative mb-3">
                <RemoteConnectionHistoryInput
                  className="h-9 pr-10 text-ui-base"
                  value={privateKeyPath}
                  onChange={setPrivateKeyPath}
                  placeholder={intl.formatMessage({
                    id: "ssh.privateKeyPlaceholder",
                  })}
                  suggestions={sshHistorySuggestions.privateKeyPaths}
                  emptyText={intl.formatMessage({
                    id: "remote.history.empty",
                  })}
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid={TID_SSH_PRIVATE_KEY_INPUT}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className="absolute top-1/2 right-0.5 -translate-y-1/2"
                  title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
                  onClick={() => {
                    void (async () => {
                      const selectedPath = await platform.selectFile();
                      if (selectedPath) {
                        setPrivateKeyPath(selectedPath);
                      }
                    })();
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              <label className="mb-1 block text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
              </label>
              <Input
                size="lg"
                className="h-9 text-ui-base"
                type="password"
                value={privateKeyPassphrase}
                onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                placeholder={intl.formatMessage({
                  id: "ssh.privateKeyPassphrasePlaceholder",
                })}
                name="remote-ssh-private-key-passphrase"
                autoComplete="off"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.assetInstallMode" })}
            </label>
            <div className="inline-flex w-full max-w-md flex-col items-stretch rounded-lg border border-input-border bg-input p-[3px] sm:w-fit sm:flex-row sm:items-center">
              {(["local-download-upload", "remote-download"] as const).map((value) => {
                const selected = assetInstallMode === value;

                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAssetInstallMode(value)}
                    className={cn(
                      "inline-flex min-h-7 min-w-0 flex-1 items-center justify-center rounded-md px-3 py-1 text-center text-ui-base font-medium transition-colors sm:flex-none",
                      selected
                        ? "bg-background text-foreground"
                        : "text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 break-words">
                      {intl.formatMessage({
                        id: `ssh.assetInstallMode.${value}`,
                      })}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}
            </p>
          </div>
        </div>
      );
  }
}
