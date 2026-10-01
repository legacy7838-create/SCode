import type { RemoteAssetInstallMode, RemoteTarget } from "@zcode/shared";
import { normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

type WizardIntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

interface RemoteConnectionFormSnapshot {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode?: RemoteAssetInstallMode;
  selectedSshConfigAlias?: string | null;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslUser?: string;
}

export function getRemoteWizardStepCopy(
  intl: WizardIntlLike,
  step: RemoteWizardStep,
  kind: RemoteTarget["kind"],
) {
  switch (step) {
    case "kind":
      return {
        title: intl.formatMessage({ id: "remote.kindStepTitle" }),
        description: intl.formatMessage({ id: "remote.kindStepDescription" }),
      };
    case "settings":
      return {
        title: intl.formatMessage({ id: "remote.settingsStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.settingsStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "connecting":
      return {
        title: intl.formatMessage({ id: "remote.connectingStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.connectingStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "directory":
      return {
        title: intl.formatMessage({ id: "remote.selectDirectoryTitle" }),
        description: intl.formatMessage({ id: "remote.selectDirectoryDescription" }),
      };
  }
}

export function buildRemoteTarget(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
): { target?: RemoteTarget; errorMessage?: string } {
  switch (snapshot.kind) {
    case "ssh":
      if (!snapshot.host || !snapshot.username) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.required" }),
        };
      }

      if (snapshot.sshAuthMethod === "password" && !snapshot.password) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.passwordRequired" }),
        };
      }

      if (snapshot.sshAuthMethod === "privateKey" && !snapshot.privateKeyPath) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.privateKeyRequired" }),
        };
      }

      const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();

      return {
        target: {
          kind: "ssh",
          host: snapshot.host,
          port: snapshot.port ? Number(snapshot.port) : undefined,
          username: snapshot.username,
          ...(sshConfigAlias ? { sshConfigAlias } : {}),
          assetInstallMode: snapshot.assetInstallMode,
          ...(snapshot.sshAuthMethod === "password" && snapshot.password
            ? { password: snapshot.password }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPath
            ? { privateKeyPath: snapshot.privateKeyPath }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPassphrase
            ? { privateKeyPassphrase: snapshot.privateKeyPassphrase }
            : {}),
        },
      };
  }
}

export function withDefaultRemoteResourcePackages(target: RemoteTarget): RemoteTarget {
  if (target.kind !== "ssh") {
    return target;
  }

  return {
    ...target,
    resourcePackages: {
      // The current branch only retains one ZCode Agent. If the SSH wizard allows the user to manually select resource packages, it will produce meaningless forks.
      // The default active resource set is unified here, and the old selections passed in by historical reconnection will no longer affect the deployment scope.
      selectedPackageIds: normalizeRemoteResourcePackageSelection(),
    },
  };
}
