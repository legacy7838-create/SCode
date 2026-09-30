import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteAssetInstallMode,
  RemoteTarget,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

type RemoteKind = RemoteTarget["kind"];
export type SSHAuthMethod = "password" | "privateKey";

function buildAvailableKinds(options: { isWindowsDesktop: boolean }): RemoteKind[] {
  const kinds: RemoteKind[] = ["ssh"];
  // In the remote connection entry, WSL and SSH are both host-type connections.
  if (options.isWindowsDesktop) {
    kinds.push("wsl");
  }
  return kinds;
}

export function useRemoteConnectionForm({
  open,
  isWindowsDesktop,
  preferredKind,
  preferredWslDistro,
}: {
  open: boolean;
  isWindowsDesktop: boolean;
  preferredKind?: RemoteKind;
  preferredWslDistro?: string;
}) {
  const platform = usePlatform();
  const [kind, setKind] = useState<RemoteKind>("ssh");
  const [host, setHostState] = useState("");
  const [port, setPortState] = useState("22");
  const [username, setUsernameState] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>("password");
  const [assetInstallMode, setAssetInstallMode] = useState<RemoteAssetInstallMode>(
    DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  );
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPathState] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslUser, setWslUser] = useState("");
  const [sshConfigAliases, setSshConfigAliases] = useState<SSHConfigAliasOption[]>([]);
  const [sshConfigAliasesLoading, setSshConfigAliasesLoading] = useState(false);
  const [sshConfigAliasesLoaded, setSshConfigAliasesLoaded] = useState(false);
  const [sshConfigAliasesError, setSshConfigAliasesError] = useState("");
  const [selectedSshConfigAlias, setSelectedSshConfigAlias] = useState<string | null>(null);
  const [wslDistros, setWslDistros] = useState<WSLDistro[]>([]);
  const [wslOptionsLoading, setWslOptionsLoading] = useState(false);
  const [wslOptionsLoaded, setWslOptionsLoaded] = useState(false);
  const [wslOptionsError, setWslOptionsError] = useState("");
  const applyingSshAliasRef = useRef(false);
  const availableKinds = useMemo(
    () => buildAvailableKinds({ isWindowsDesktop }),
    [isWindowsDesktop],
  );

  useEffect(() => {
    if (availableKinds.includes(kind)) {
      return;
    }

    setKind(availableKinds[0] ?? "ssh");
  }, [availableKinds, kind]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setSshConfigAliases([]);
    setSshConfigAliasesLoading(false);
    setSshConfigAliasesLoaded(false);
    setSshConfigAliasesError("");
    setSelectedSshConfigAlias(null);
    setWslOptionsLoaded(false);
    setWslOptionsLoading(false);
    setWslOptionsError("");
    setWslDistros([]);
    if (preferredKind && availableKinds.includes(preferredKind)) {
      setKind(preferredKind);
    }
    if (preferredWslDistro !== undefined) {
      setWslDistro(preferredWslDistro);
    }
  }, [availableKinds, open, preferredKind, preferredWslDistro]);

  useEffect(() => {
    if (!open || kind !== "ssh" || sshConfigAliasesLoaded) {
      return;
    }

    let cancelled = false;
    setSshConfigAliasesLoading(true);
    setSshConfigAliasesError("");

    void (async () => {
      try {
        const aliases = await platform.listSSHConfigAliases();
        if (cancelled) {
          return;
        }

        setSshConfigAliases(aliases);
        setSshConfigAliasesLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setSshConfigAliases([]);
        setSshConfigAliasesLoaded(true);
        setSshConfigAliasesError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setSshConfigAliasesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [kind, open, platform, sshConfigAliasesLoaded]);

  useEffect(() => {
    if (!selectedSshConfigAlias) {
      return;
    }

    if (sshConfigAliases.some((option) => option.alias === selectedSshConfigAlias)) {
      return;
    }

    setSelectedSshConfigAlias(null);
  }, [selectedSshConfigAlias, sshConfigAliases]);

  useEffect(() => {
    if (!open || kind !== "wsl" || !isWindowsDesktop || wslOptionsLoaded) {
      return;
    }

    let cancelled = false;
    setWslOptionsLoading(true);
    setWslOptionsError("");

    void (async () => {
      try {
        const nextWslDistros = await platform.listWSLDistros();
        if (cancelled) {
          return;
        }

        setWslDistros(nextWslDistros);
        setWslOptionsLoaded(true);
      } catch (runtimeError) {
        if (cancelled) {
          return;
        }

        setWslDistros([]);
        setWslOptionsLoaded(true);
        setWslOptionsError(String(runtimeError));
      } finally {
        if (!cancelled) {
          setWslOptionsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isWindowsDesktop, kind, open, platform, wslOptionsLoaded]);

  const setHost = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== host) {
      setSelectedSshConfigAlias(null);
    }
    setHostState(value);
  };

  const setPort = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== port) {
      setSelectedSshConfigAlias(null);
    }
    setPortState(value);
  };

  const setUsername = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== username) {
      setSelectedSshConfigAlias(null);
    }
    setUsernameState(value);
  };

  const setPrivateKeyPath = (value: string) => {
    if (!applyingSshAliasRef.current && selectedSshConfigAlias && value !== privateKeyPath) {
      setSelectedSshConfigAlias(null);
    }
    setPrivateKeyPathState(value);
  };

  const applySshConfigAlias = (aliasOption: SSHConfigAliasOption) => {
    applyingSshAliasRef.current = true;
    try {
      setSelectedSshConfigAlias(aliasOption.alias);
      const nextHost = aliasOption.host?.trim() || aliasOption.alias;
      const nextPort =
        aliasOption.port != null && Number.isFinite(aliasOption.port)
          ? String(aliasOption.port)
          : "";
      const nextUsername = aliasOption.username?.trim() ?? "";
      const nextPrivateKeyPath = aliasOption.privateKeyPath?.trim() ?? "";

      // Previously switching alias only overwrote "fields with values", so missing fields kept the previous alias/manually entered value.
      // Now it overwrites in full: every SSH field is rebuilt from the current alias, missing values are cleared to empty, avoiding state leaking across aliases.
      setHostState(nextHost);
      setPortState(nextPort);
      setUsernameState(nextUsername);
      setPassword("");
      setPrivateKeyPathState(nextPrivateKeyPath);
      setPrivateKeyPassphrase("");
      setSshAuthMethod(nextPrivateKeyPath ? "privateKey" : "password");
    } finally {
      applyingSshAliasRef.current = false;
    }
  };

  const clearSelectedSshConfigAlias = () => {
    setSelectedSshConfigAlias(null);
  };

  return {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    wslDistros,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading: kind === "wsl" && wslOptionsLoading,
    currentRuntimeOptionsError: kind === "wsl" ? wslOptionsError : "",
  };
}
