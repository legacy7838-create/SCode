import { app, BrowserWindow, Menu } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isValidShortcutBinding,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type DesktopMenuMessageId,
} from "@zcode/shared";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import { CHECK_FOR_UPDATE_MENU_ID, syncAutoUpdaterMenuItemState } from "./autoUpdater.js";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
} from "./desktopZoom.js";
import {
  HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
  HELP_TOGGLE_DEV_TOOLS_MENU_ID,
} from "./desktopCommandHandlers.js";

const HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID = "help.zcode-endpoint.production";

export function updateZCodeStdioTapDevMenuState() {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID);
  if (!item) {
    return;
  }
  const state = readZCodeStdioTapDevState();
  item.checked = state.enabled;
  item.visible = state.visible;
}

/** The shortcut keys for menu channel commands share the options type (shortcutBindings is overridden by users in setting.json). */
interface ApplicationMenuShortcutOptions {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * Parse menu accelerator from user override: explicit empty array = "unset" after grab binding (no accelerator);
 * Fallback to hard-coded default values when overriding all is illegal (same semantics as renderer validity table).
 * The main process only needs "command → accelerator string", and the complete semantics of the effective table are in the ui shortcut key core.
 * The recording state returns undefined (the menu item does not have an accelerator and can still be clicked) to prevent the recording button from triggering the original command.
 */
function resolveMenuAccelerator(
  options: ApplicationMenuShortcutOptions & { disableShortcutAccelerators?: boolean },
  commandId: string,
  fallback: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  // `?.find(isValid) ?? fallback` will combine "explicit empty array = not set" with
  // "All illegal = fallback to default" is pressed into the same path, and the default accelerator of the robbed command is resurrected after being robbed.
  // The same key has double actions and is inconsistent with the UI promise of "the command being snatched becomes unset".
  const overrideList = options?.shortcutBindings?.[commandId];
  if (overrideList !== undefined) {
    if (overrideList.length === 0) {
      return undefined;
    }
    return overrideList.find((binding) => isValidShortcutBinding(binding)) ?? fallback;
  }
  return fallback;
}

function buildApplicationMenuTemplate(options: {
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** Shortcut key settings page recording status: remove all configurable accelerator when true */
  disableShortcutAccelerators?: boolean;
}): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: DesktopMenuMessageId) => getDesktopMenuMessage(id);
  const getAppLabel = (id: DesktopMenuMessageId) => getLabel(id).replaceAll("{appName}", app.name);
  const stdioTapState = readZCodeStdioTapDevState();
  const isLocalDevelopmentRuntime = !app.isPackaged;
  const currentZoomLevel = clampDesktopZoomLevel(options.currentZoomLevel ?? 0);
  const canResetZoom = currentZoomLevel !== 0;
  const canZoomIn = currentZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = currentZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // Keep Plus visible when zoomIn main binding contains "=" + "=" hidden double entry (Plus shows better in menu, "=" hides Windows without Shift direct click).
  // The accelerator in the recording state is undefined (remove the key and the menu item remains clickable).
  const zoomInBinding = resolveMenuAccelerator(options, "zoomIn", "CmdOrCtrl+=");
  const zoomInVisibleAccelerator = zoomInBinding?.replace("=", "Plus");

  return [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              // The update portal follows the product identity: Preview disables the updater, and Preview on the production backend is no exception.
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.appServices),
                role: "services" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appHide),
                role: "hide" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appHideOthers),
                role: "hideOthers" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appShowAll),
                role: "unhide" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appQuit),
                role: "quit" as const,
              },
            ],
          },
        ]
      : []),
    {
      label: getLabel(desktopMenuMessageIds.file),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          accelerator: resolveMenuAccelerator(options, "newTask", "CmdOrCtrl+N"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          accelerator: resolveMenuAccelerator(options, "openWorkspace", "CmdOrCtrl+O"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.fileCloseWindow),
          accelerator: resolveMenuAccelerator(options, "closeActiveContext", "CmdOrCtrl+W"),
          // Electron's close role will close the window directly in the main process, and the renderer has no chance to judge.
          // Whether there is an active tab on the right side pane. Here it is changed to a business command, so that the shortcut keys enter the workspace state machine first.
          click: () => void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.edit),
      // Using Electron's editMenu/windowMenu role at the top level will generate copy according to the system locale.
      // When mixed with the menu copy explicitly specified here, there will be inconsistencies between Chinese and English.
      submenu: [
        { label: getLabel(desktopMenuMessageIds.editUndo), role: "undo" as const },
        { label: getLabel(desktopMenuMessageIds.editRedo), role: "redo" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editCut), role: "cut" as const },
        { label: getLabel(desktopMenuMessageIds.editCopy), role: "copy" as const },
        { label: getLabel(desktopMenuMessageIds.editPaste), role: "paste" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editSelectAll), role: "selectAll" as const },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.view),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.viewToggleFullScreen),
          role: "togglefullscreen" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleFullScreen),
        },
        { type: "separator" as const },
        // The zoom command's accelerator follows user shortcut key settings (shortcutBindings user override).
        {
          label: getLabel(desktopMenuMessageIds.viewZoomIn),
          accelerator: zoomInVisibleAccelerator,
          enabled: canZoomIn,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
        },
        ...(zoomInVisibleAccelerator !== undefined && zoomInVisibleAccelerator !== zoomInBinding
          ? [
              {
                label: getLabel(desktopMenuMessageIds.viewZoomIn),
                accelerator: zoomInBinding,
                visible: false,
                enabled: canZoomIn,
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.viewZoomOut),
          accelerator: resolveMenuAccelerator(options, "zoomOut", "CmdOrCtrl+-"),
          enabled: canZoomOut,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomOut),
        },
        {
          label: getLabel(desktopMenuMessageIds.viewActualSize),
          accelerator: resolveMenuAccelerator(options, "resetZoom", "CmdOrCtrl+0"),
          enabled: canResetZoom,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ResetZoom),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.window),
      submenu: [
        { label: getLabel(desktopMenuMessageIds.windowMinimize), role: "minimize" as const },
        ...(process.platform === "darwin"
          ? [
              { label: getLabel(desktopMenuMessageIds.windowZoom), role: "zoom" as const },
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.windowBringAllToFront),
                role: "front" as const,
              },
            ]
          : []),
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.help),
      submenu: [
        ...(process.platform !== "darwin"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpWhatsNew),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenChangelog),
        },
        { type: "separator" as const },
        ...(isLocalDevelopmentRuntime && stdioTapState.visible
          ? [
              {
                id: HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
                label: getLabel(desktopMenuMessageIds.helpToggleZCodeStdioTap),
                type: "checkbox" as const,
                checked: stdioTapState.enabled,
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy),
              },
              { type: "separator" as const },
            ]
          : []),
        ...(ZCODE_ENV === "test"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpZCodeEndpoint),
                submenu: [
                  {
                    id: HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointProduction),
                    type: "radio" as const,
                    checked: (options.zcodeEndpointSelection ?? "production") === "production",
                    click: () =>
                      void options.executeDesktopCommand(
                        DesktopCommandIds.SetZCodeEndpointProduction,
                      ),
                  },
                  { type: "separator" as const },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointCustom),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointCustom),
                  },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointReset),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.ResetZCodeEndpoint),
                  },
                ],
              },
              { type: "separator" as const },
            ]
          : []),
        {
          id: HELP_TOGGLE_DEV_TOOLS_MENU_ID,
          label: getLabel(desktopMenuMessageIds.helpToggleDevTools),
          role: "toggleDevTools" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleDevTools),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpResourceManager),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpFeedback),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ClearAllData),
        },
      ],
    },
  ];
}

export function rebuildApplicationMenu(options: {
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** Shortcut key settings page recording status: remove all configurable accelerator when true */
  disableShortcutAccelerators?: boolean;
}) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        zcodeEndpointSelection: options.zcodeEndpointSelection,
        executeDesktopCommand: options.executeDesktopCommand,
        currentZoomLevel: options.currentZoomLevel,
        shortcutBindings: options.shortcutBindings,
        disableShortcutAccelerators: options.disableShortcutAccelerators,
      }),
    ),
  );
  syncAutoUpdaterMenuItemState();
  if (!app.isPackaged) {
    updateZCodeStdioTapDevMenuState();
  }
}
