export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;

export function validateRemoteServerBundle({ source }: RemoteServerBundleValidationInput): void {
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // remote deploy will only upload a single zcode-server.cjs to ~/.zcode/server/.
    // Only the bare undici runtime import remaining in the bundle means that the remote end still depends on node_modules;
    // If the current code no longer uses undici, "no dependencies" should not be misjudged as "not inlined".
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }
}
