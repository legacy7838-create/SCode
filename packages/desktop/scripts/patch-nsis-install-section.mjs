import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

const PATCH_MARKER = "; zcode-installer-details-v1";

function optionalMacro(name) {
  return [`!ifmacrodef ${name}`, `  !insertmacro ${name}`, "!endif"].join("\n");
}

function replaceRequired(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`electron-builder installSection.nsh is missing expected anchor: ${label}`);
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

/**
 * Add the visible stage to the installation section of electron-builder and enable NSIS built-in file-by-file details.
 *
 * The entire upstream template is not copied here to avoid silently bringing in the old template when electron-builder upgrades; each package
 * All must hit the structural anchor point below. Template structure changes will fail immediately and remind the maintainer to realign.
 */
export function patchNsisInstallSectionSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (patched.includes(PATCH_MARKER)) {
    return source;
  }

  const detailsAnchor = "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}";
  patched = replaceRequired(
    patched,
    detailsAnchor,
    [
      PATCH_MARKER,
      "# The details area needs to display the File entry and project stage of electron-builder at the same time.",
      "${IfNot} ${Silent}",
      "  SetDetailsPrint listonly",
      "${endif}",
      optionalMacro("customInstallSectionStarted"),
    ].join("\n"),
    "SetDetailsPrint none",
  );

  const cleanupStartAnchor =
    "!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT";
  patched = replaceRequired(
    patched,
    cleanupStartAnchor,
    `${optionalMacro("customInstallCleanupStarted")}\n${cleanupStartAnchor}`,
    "SHELL_CONTEXT cleanup",
  );

  const cleanupEndAnchor =
    '${if} $installMode == "all"\n  !insertmacro uninstallOldVersion HKEY_CURRENT_USER\n  !insertmacro handleUninstallResult HKEY_CURRENT_USER\n${endIf}';
  patched = replaceRequired(
    patched,
    cleanupEndAnchor,
    `${cleanupEndAnchor}\n${optionalMacro("customInstallCleanupCompleted")}`,
    "HKEY_CURRENT_USER cleanup",
  );

  const extractAnchor = "!insertmacro installApplicationFiles";
  patched = replaceRequired(
    patched,
    extractAnchor,
    `${optionalMacro("customInstallExtractStarted")}\n${extractAnchor}\n${optionalMacro("customInstallExtractCompleted")}`,
    "application extraction",
  );

  const shortcutsAnchor =
    "!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts";
  patched = replaceRequired(
    patched,
    shortcutsAnchor,
    `${optionalMacro("customInstallShortcutsStarted")}\n${shortcutsAnchor}\n${optionalMacro("customInstallShortcutsCompleted")}`,
    "shortcut installation",
  );

  return sourceEol === "\r\n" ? patched.replaceAll("\n", "\r\n") : patched;
}

export async function patchNsisInstallSectionFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisInstallSectionSource(source);
  if (patched === source) {
    return { changed: false, originalSource: null };
  }

  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}

export function restoreNsisInstallSectionFileSync({ filePath, originalSource }) {
  if (originalSource !== null) {
    writeFileSync(filePath, originalSource, "utf8");
  }
}

export { PATCH_MARKER };
