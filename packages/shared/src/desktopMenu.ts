export const desktopMenuMessageIds = {
  file: "titleBar.menu.file",
  edit: "titleBar.menu.edit",
  view: "titleBar.menu.view",
  window: "titleBar.menu.window",
  help: "titleBar.menu.help",
  fileNewTask: "titleBar.menu.file.newTask",
  fileOpenWorkspace: "titleBar.menu.file.openWorkspace",
  fileCloseWindow: "titleBar.menu.file.closeWindow",
  editUndo: "titleBar.menu.edit.undo",
  editRedo: "titleBar.menu.edit.redo",
  editCut: "titleBar.menu.edit.cut",
  editCopy: "titleBar.menu.edit.copy",
  editPaste: "titleBar.menu.edit.paste",
  editDelete: "titleBar.menu.edit.delete",
  editSelectAll: "titleBar.menu.edit.selectAll",
  viewToggleFullScreen: "titleBar.menu.view.toggleFullScreen",
  viewActualSize: "titleBar.menu.view.actualSize",
  viewZoomIn: "titleBar.menu.view.zoomIn",
  viewZoomOut: "titleBar.menu.view.zoomOut",
  windowMinimize: "titleBar.menu.window.minimize",
  windowZoom: "titleBar.menu.window.zoom",
  windowBringAllToFront: "titleBar.menu.window.bringAllToFront",
  appServices: "titleBar.menu.app.services",
  appHide: "titleBar.menu.app.hide",
  appHideOthers: "titleBar.menu.app.hideOthers",
  appShowAll: "titleBar.menu.app.showAll",
  appQuit: "titleBar.menu.app.quit",
  helpAbout: "titleBar.menu.help.about",
  helpWhatsNew: "titleBar.menu.help.whatsNew",
  helpCheckForUpdates: "titleBar.menu.help.checkForUpdates",
  helpToggleDevTools: "titleBar.menu.help.toggleDevTools",
  helpResourceManager: "titleBar.menu.help.resourceManager",
  helpToggleZCodeStdioTap: "titleBar.menu.help.toggleZCodeStdioTap",
  helpZCodeEndpoint: "titleBar.menu.help.zcodeEndpoint",
  helpZCodeEndpointProduction: "titleBar.menu.help.zcodeEndpoint.production",
  helpZCodeEndpointTest: "titleBar.menu.help.zcodeEndpoint.test",
  helpZCodeEndpointCustom: "titleBar.menu.help.zcodeEndpoint.custom",
  helpZCodeEndpointReset: "titleBar.menu.help.zcodeEndpoint.reset",
  helpFeedback: "titleBar.menu.help.feedback",
  helpExportLogs: "titleBar.menu.help.exportLogs",
  helpClearAllData: "titleBar.menu.help.clearAllData",
  helpCheckingForUpdates: "desktopMenu.help.checkingForUpdates",
  helpUpdateAvailableVersion: "desktopMenu.help.updateAvailableVersion",
  helpDownloadingUpdateVersion: "desktopMenu.help.downloadingUpdateVersion",
  helpDownloadingUpdateProgress: "desktopMenu.help.downloadingUpdateProgress",
  helpRestartToUpdate: "desktopMenu.help.restartToUpdate",
  dockShowCurrentWindow: "dock.menu.showCurrentWindow",
  trayTooltip: "tray.tooltip",
  trayOpenZCode: "tray.menu.openZCode",
  trayQuit: "tray.menu.quit",
} as const;

export type DesktopMenuMessageId =
  (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds];

type DesktopMenuLocaleMessages = Record<DesktopMenuMessageId, string>;

export const desktopMenuMessages: DesktopMenuLocaleMessages = {
  "titleBar.menu.file": "File",
  "titleBar.menu.edit": "Edit",
  "titleBar.menu.view": "View",
  "titleBar.menu.window": "Window",
  "titleBar.menu.help": "Help",
  "titleBar.menu.file.newTask": "New task",
  "titleBar.menu.file.openWorkspace": "Open workspace",
  "titleBar.menu.file.closeWindow": "Close window",
  "titleBar.menu.edit.undo": "Undo",
  "titleBar.menu.edit.redo": "Redo",
  "titleBar.menu.edit.cut": "Cut",
  "titleBar.menu.edit.copy": "Copy",
  "titleBar.menu.edit.paste": "Paste",
  "titleBar.menu.edit.delete": "Delete",
  "titleBar.menu.edit.selectAll": "Select all",
  "titleBar.menu.view.toggleFullScreen": "Toggle full screen",
  "titleBar.menu.view.actualSize": "Actual size",
  "titleBar.menu.view.zoomIn": "Zoom in",
  "titleBar.menu.view.zoomOut": "Zoom out",
  "titleBar.menu.window.minimize": "Minimize",
  "titleBar.menu.window.zoom": "Zoom",
  "titleBar.menu.window.bringAllToFront": "Bring all to front",
  "titleBar.menu.app.services": "Services",
  "titleBar.menu.app.hide": "Hide {appName}",
  "titleBar.menu.app.hideOthers": "Hide others",
  "titleBar.menu.app.showAll": "Show all",
  "titleBar.menu.app.quit": "Quit {appName}",
  "titleBar.menu.help.about": "About ZCode",
  "titleBar.menu.help.whatsNew": "What's new",
  "titleBar.menu.help.checkForUpdates": "Check for updates",
  "titleBar.menu.help.toggleDevTools": "Toggle developer tools",
  "titleBar.menu.help.resourceManager": "Resource manager",
  "titleBar.menu.help.toggleZCodeStdioTap": "Capture agent stdio traffic",
  "titleBar.menu.help.zcodeEndpoint": "ZCode Endpoint",
  "titleBar.menu.help.zcodeEndpoint.production": "Production (default)",
  "titleBar.menu.help.zcodeEndpoint.test": "Test",
  "titleBar.menu.help.zcodeEndpoint.custom": "Custom...",
  "titleBar.menu.help.zcodeEndpoint.reset": "Reset to default",
  "titleBar.menu.help.feedback": "Feedback",
  "titleBar.menu.help.exportLogs": "Export logs",
  "titleBar.menu.help.clearAllData": "Clear all data",
  "desktopMenu.help.checkingForUpdates": "Checking for updates...",
  "desktopMenu.help.updateAvailableVersion": "Update available {version}",
  "desktopMenu.help.downloadingUpdateVersion": "Downloading update {version}...",
  "desktopMenu.help.downloadingUpdateProgress": "Downloading update... {progress}",
  "desktopMenu.help.restartToUpdate": "Restart to update ({version})",
  "dock.menu.showCurrentWindow": "Show current window",
  "tray.tooltip": "ZCode",
  "tray.menu.openZCode": "Open ZCode",
  "tray.menu.quit": "Quit",
};

export function getDesktopMenuMessage(id: DesktopMenuMessageId): string {
  return desktopMenuMessages[id];
}

export function formatDesktopMenuMessage(
  id: DesktopMenuMessageId,
  values?: Record<string, string | number>,
): string {
  let message = getDesktopMenuMessage(id);
  if (!values) {
    return message;
  }

  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value));
  }

  return message;
}
