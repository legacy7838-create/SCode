import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri v2 桥接层 —— Phase 2 垂直切片的 TypeScript 侧接缝。
 *
 * 本模块只覆盖 `tauri-port/BRIDGE.md` 约定的三个低风险命令，用于端到端验证
 * `invoke()` ⇄ `#[tauri::command]` 调用模式。完整 `IPlatformService`（104 个方法）
 * 适配器在后续阶段实现，此处不做任何 Electron 行为改动，保持叠加式接入。
 *
 * 设计约束：
 * - 导入时零副作用（不在顶层调用 `invoke`）。
 * - 运行时能力探测，不硬依赖 `window.__TAURI_INTERNALS__` 全局在加载期存在。
 */

/**
 * 检测当前是否运行在 Tauri 运行时下。
 *
 * 通过能力探测 `window.__TAURI_INTERNALS__` 判断，避免在模块加载期强依赖该全局；
 * 只有返回 true 时才应走 Tauri 桥接路径，否则保留既有 Electron 路径。
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 读取应用包版本，例如 `"0.0.0"`。
 * 对应 Rust 命令 `get_app_version`，源自 `app.package_info().version`。
 */
export function getTauriAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/**
 * 读取系统语言，BCP-47 风格，例如 `"en-US"`。
 * 对应 Rust 命令 `get_system_locale`，源自 `sys_locale::get_locale()`，回退 `"en-US"`。
 */
export function getTauriSystemLocale(): Promise<string> {
  return invoke<string>("get_system_locale");
}

/**
 * 读取稳定设备标识，可能为空字符串（不可用时）。
 * 对应 Rust 命令 `get_device_id`，源自环境变量 `ZCODE_DEVICE_ID`。
 */
export function getTauriDeviceId(): Promise<string> {
  return invoke<string>("get_device_id");
}

/**
 * 宿主操作系统与 CPU 架构信息。
 * 对应 Rust 端 `PlatformInfo { os, arch }`，源自 `std::env::consts`。
 */
export interface TauriPlatformInfo {
  /** 操作系统标识，例如 `"linux"`、`"macos"`、`"windows"`。 */
  os: string;
  /** CPU 架构标识，例如 `"x86_64"`、`"aarch64"`。 */
  arch: string;
}

/**
 * 读取宿主操作系统与 CPU 架构。
 * 对应 Rust 命令 `get_platform_info`，源自编译期常量 `std::env::consts::{OS, ARCH}`。
 *
 * Phase 2 第二切片：仅新增此命令与 `get_app_name`，保持叠加式接入、导入零副作用。
 */
export function getTauriPlatformInfo(): Promise<TauriPlatformInfo> {
  return invoke<TauriPlatformInfo>("get_platform_info");
}

/**
 * 读取应用包名称，例如 `"ZCode"`。
 * 对应 Rust 命令 `get_app_name`，源自 `app.package_info().name`。
 *
 * Phase 2 第二切片：与 `getTauriPlatformInfo` 一同接入。
 */
export function getTauriAppName(): Promise<string> {
  return invoke<string>("get_app_name");
}

/**
 * 读取宿主操作系统的“下载”目录，例如 `"/home/user/Downloads"`。
 * 对应 Rust 命令 `get_download_directory`，源自 Tauri 内置路径解析器 `app.path().download_directory()`。
 *
 * Phase 2 第三切片：这是首个可失败（fallible）命令。Rust 端返回 `Result<String, String>`，
 * 失败时的 `Err(String)` 会在这里以 rejected Promise 的形式抛出 —— 即错误传播接缝。
 * 调用方应通过 `.catch`/`try-catch` 处理目录无法解析的情况。保持导入零副作用。
 */
export function getTauriDownloadDir(): Promise<string> {
  return invoke<string>("get_download_directory");
}

/**
 * 读取宿主操作系统的“文档”目录，例如 `"/home/user/Documents"`。
 * 对应 Rust 命令 `get_documents_directory`，源自 `app.path().document_directory()`。
 *
 * 与 `getTauriDownloadDir` 共享同一可失败契约：Rust `Err` 在此表现为 rejected Promise。
 */
export function getTauriDocumentsDir(): Promise<string> {
  return invoke<string>("get_documents_directory");
}

/**
 * Phase 2 第四切片：窗口管理命令的 TypeScript 接缝。
 *
 * 所有函数都作用于 Tauri 的窗口 label（默认主窗口为 `"main"`），可显式传入其他 label。
 * Rust 端通过 `app.get_webview_window(label)` 解析窗口；窗口不存在或系统拒绝操作时返回
 * `Err(String)`，在这里表现为 rejected Promise（沿用第三切片的错误传播接缝）。
 * 本组函数无副作用（导入零副作用原则不变），仅在显式调用时触发 `invoke`。
 */

/** Tauri 主窗口的默认 label，与 `tauri.conf.json` 中注册一致。 */
const DEFAULT_WINDOW_LABEL = "main";

/**
 * 最小化指定窗口。对应 Rust 命令 `window_minimize`（`WebviewWindow::minimize`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowMinimize(label?: string): Promise<void> {
  return invoke<void>("window_minimize", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 最大化指定窗口。对应 Rust 命令 `window_maximize`（`WebviewWindow::maximize`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowMaximize(label?: string): Promise<void> {
  return invoke<void>("window_maximize", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 取消最大化（还原）指定窗口。对应 Rust 命令 `window_unmaximize`
 * （`WebviewWindow::unmaximize`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowUnmaximize(label?: string): Promise<void> {
  return invoke<void>("window_unmaximize", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 切换指定窗口的全屏状态。对应 Rust 命令 `window_toggle_fullscreen`。注意：Tauri 2.12 的
 * `WebviewWindow` 没有 `toggle_fullscreen`，Rust 端以 `is_fullscreen` 读取真实状态后取反调用
 * `set_fullscreen` 实现（全屏时退出、窗口化时进入）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowToggleFullscreen(label?: string): Promise<void> {
  return invoke<void>("window_toggle_fullscreen", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * 关闭指定窗口。对应 Rust 命令 `window_close`（`WebviewWindow::close`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowClose(label?: string): Promise<void> {
  return invoke<void>("window_close", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 聚焦（前置并激活）指定窗口。对应 Rust 命令 `window_set_focus`
 * （`WebviewWindow::set_focus`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowSetFocus(label?: string): Promise<void> {
  return invoke<void>("window_set_focus", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 查询指定窗口当前是否处于最大化状态，返回真实状态。
 * 对应 Rust 命令 `window_is_maximized`（`WebviewWindow::is_maximized`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function windowIsMaximized(label?: string): Promise<boolean> {
  return invoke<boolean>("window_is_maximized", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * Phase 2 第五切片：原生对话框命令的 TypeScript 接缝（`tauri-plugin-dialog`）。
 *
 * 这些函数在 Rust 端通过 `app.dialog()` 的真实阻塞式原生对话框 API 实现（文件选择、保存、
 * 消息框）。参数以 camelCase 对象传入，Tauri 自动映射为 Rust 的 snake_case 形参。
 *
 * 运行时约束：原生对话框需要一个正在运行的窗口（GUI），因此这些接缝只在此处做“编译期”类型
 * 校验；真实交互在 `pnpm dev:tauri` 下运行验证。Rust 端为 `async` 命令，在 worker 线程阻塞
 * 等待主线程弹出的原生对话框结果（避免冻结事件循环）。保持导入零副作用。
 */

/** 文件类型过滤器，映射 Rust 端 `DialogFilter { extensions, name }`。 */
export interface TauriDialogFilter {
  /** 不含前导点的扩展名列表，例如 `["rs", "toml"]`。 */
  extensions: string[];
  /** 原生对话框中展示的可读名称，例如 `"Source"`。 */
  name: string;
}

/** `showOpenDialog` 选项。 */
export interface TauriOpenDialogOptions {
  /** 是否允许多选。缺省为 `false`（单选）。 */
  multiple?: boolean;
  /** 文件类型过滤器列表。 */
  filters?: TauriDialogFilter[];
}

/**
 * 打开原生“选择文件”对话框，返回用户选中的路径数组；取消时返回 `null`。
 * 对应 Rust 命令 `show_open_dialog`（`blocking_pick_files` / `blocking_pick_file`）。
 *
 * @param options - 多选与过滤条件；缺省为单选、无过滤。
 */
export function showOpenDialog(
  options: TauriOpenDialogOptions = {},
): Promise<string[] | null> {
  return invoke<string[] | null>("show_open_dialog", {
    multiple: options.multiple ?? false,
    filters: options.filters ?? [],
  });
}

/** `showSaveDialog` 选项。 */
export interface TauriSaveDialogOptions {
  /** 建议的默认保存路径（目录 + 文件名）；缺省不预设。 */
  defaultPath?: string;
}

/**
 * 打开原生“另存为”对话框，返回用户选择的目标路径；取消时返回 `null`。
 * 对应 Rust 命令 `show_save_dialog`（`blocking_save_file`）。
 *
 * @param options - 默认路径建议。
 */
export function showSaveDialog(
  options: TauriSaveDialogOptions = {},
): Promise<string | null> {
  return invoke<string | null>("show_save_dialog", {
    defaultPath: options.defaultPath ?? null,
  });
}

/** `showMessageDialog` 选项。 */
export interface TauriMessageDialogOptions {
  /** 对话框严重级别，决定图标；缺省 `"info"`。 */
  kind?: "info" | "warning" | "error";
  /** 标题。 */
  title: string;
  /** 正文消息。 */
  message: string;
}

/**
 * 打开原生模态消息对话框（Yes/No 按钮），返回用户是否确认。
 * 对应 Rust 命令 `show_message_dialog`（`blocking_show`）：`true` 表示点击 Yes，`false` 表示 No。
 *
 * @param options - 严重级别、标题与消息文本。
 */
export function showMessageDialog(
  options: TauriMessageDialogOptions,
): Promise<boolean> {
  return invoke<boolean>("show_message_dialog", {
    kind: options.kind ?? "info",
    title: options.title,
    message: options.message,
  });
}

/**
 * Phase 2 第六切片：shell / open 命令的 TypeScript 接缝（`tauri-plugin-opener`）。
 *
 * 这些函数在 Rust 端通过 `app.opener()` 调用真实的操作系统处理程序：默认浏览器打开 URL、
 * 系统文件管理器中定位文件、默认应用打开文件/目录。参数以 camelCase 对象传入，Tauri 自动
 * 映射为 Rust 的 snake_case 形参。
 *
 * 运行时约束：真实的 OS 处理程序需要一个正在运行的桌面会话（GUI），因此这些接缝在此处只做
 * “编译期”类型校验；真实行为在 `pnpm dev:tauri` 下运行验证。Rust 端返回 `Result<(), String>`，
 * 失败时的 `Err(String)` 在这里以 rejected Promise 抛出（沿用第三切片的错误传播接缝）。
 * `open_url` 的 scheme 允许列表校验为已记录的 P2 加固项，不在本切片内。保持导入零副作用。
 */

/**
 * 用系统默认浏览器/应用打开一个 URL。对应 Rust 命令 `open_url`
 * （`tauri_plugin_opener::Opener::open_url`）。
 *
 * @param url - 要打开的 URL。
 */
export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/**
 * 在系统文件管理器中定位（选中）给定路径。对应 Rust 命令 `reveal_in_folder`
 * （`tauri_plugin_opener::Opener::reveal_item_in_dir`），对齐 Electron 的 `showItemInFolder`。
 *
 * @param path - 要在文件管理器中显示的文件或目录路径。
 */
export function showItemInFolder(path: string): Promise<void> {
  return invoke<void>("reveal_in_folder", { path });
}

/**
 * 用默认应用打开文件或目录。对应 Rust 命令 `open_path`
 * （`tauri_plugin_opener::Opener::open_path`），对齐 Electron 的 `shell.openPath`。
 *
 * @param path - 要打开的文件或目录路径。
 */
export function openPath(path: string): Promise<void> {
  return invoke<void>("open_path", { path });
}

/**
 * Phase 2 第七切片：原生系统通知的 TypeScript 接缝（`tauri-plugin-notification`）。
 *
 * 对应 Rust 命令 `show_notification`，通过 `app.notification().builder()` 的真实构建器 API
 * （`.title(..).body(..).show()`）向操作系统投递通知（Linux/libnotify、macOS 用户通知、Windows
 * toast）。Rust 端返回 `Result<(), String>`，失败时的 `Err(String)` 在这里以 rejected Promise
 * 抛出（沿用第三切片的错误传播接缝）。
 *
 * 运行时约束：原生通知需要一个正在运行的窗口与已授予的操作系统通知权限，因此此接缝在此处只做
 * “编译期”类型校验；真实投递在 `pnpm dev:tauri` 下运行验证。保持导入零副作用。
 *
 * @param title - 通知标题。
 * @param body - 通知正文。
 */
export function showNotification(title: string, body: string): Promise<void> {
  return invoke<void>("show_notification", { title, body });
}

/**
 * Phase 2 第八切片：操作系统剪贴板的 TypeScript 接缝（`tauri-plugin-clipboard-manager`）。
 *
 * 对应 Rust 命令 `read_clipboard_text` / `write_clipboard_text`，委托给
 * `app.clipboard().read_text()` / `write_text(..)` 的真实系统剪贴板处理。Rust 端 `Err(String)`
 * 在此以 rejected Promise 抛出（沿用第三切片的错误传播接缝）。运行时需活动桌面会话，
 * 因此此处仅做编译期类型校验。保持导入零副作用。
 */
export function readClipboardText(): Promise<string> {
  return invoke<string>("read_clipboard_text");
}

export function writeClipboardText(text: string): Promise<void> {
  return invoke<void>("write_clipboard_text", { text });
}

/**
 * Phase 2 第九切片：窗口状态查询的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `get_window_size` / `get_window_position` / `is_window_visible` /
 * `is_window_focused`，全部复用已导入的 `WebviewWindow` API（无需新增插件）。Rust 端通过
 * `app.get_webview_window(label)` 解析窗口，缺失时返回显式的 `Err("window not found: {label}")`，
 * 这里以 rejected Promise 形式抛出（沿用第三切片的错误传播接缝）。
 *
 * 运行时约束：这些查询需要一个正在活动的窗口（GUI），因此本组接缝在此处只做“编译期”类型校验；
 * 真实读取在 `pnpm dev:tauri` 下运行验证。保持导入零副作用。
 */

/** 窗口内部（客户区）尺寸，物理像素，映射 Rust 端 `WindowSize { width, height }`。 */
export interface TauriWindowSize {
  /** 内部宽度（物理像素）。 */
  width: number;
  /** 内部高度（物理像素）。 */
  height: number;
}

/** 窗口外部（含边框）位置，物理像素，映射 Rust 端 `WindowPosition { x, y }`。 */
export interface TauriWindowPosition {
  /** 左上角 X 坐标（物理像素，可为负值）。 */
  x: number;
  /** 左上角 Y 坐标（物理像素，可为负值）。 */
  y: number;
}

/**
 * 读取窗口内部尺寸。对应 Rust 命令 `get_window_size`（`WebviewWindow::inner_size`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function getWindowSize(label?: string): Promise<TauriWindowSize> {
  return invoke<TauriWindowSize>("get_window_size", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * 读取窗口外部位置。对应 Rust 命令 `get_window_position`（`WebviewWindow::outer_position`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function getWindowPosition(label?: string): Promise<TauriWindowPosition> {
  return invoke<TauriWindowPosition>("get_window_position", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * 查询窗口当前是否可见。对应 Rust 命令 `is_window_visible`（`WebviewWindow::is_visible`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function isWindowVisible(label?: string): Promise<boolean> {
  return invoke<boolean>("is_window_visible", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * 查询窗口当前是否聚焦。对应 Rust 命令 `is_window_focused`（`WebviewWindow::is_focused`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function isWindowFocused(label?: string): Promise<boolean> {
  return invoke<boolean>("is_window_focused", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * Phase 2 第十切片：窗口变更（mutation）命令的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `set_window_title` / `set_window_size` / `set_window_position` /
 * `center_window` / `set_fullscreen` / `is_fullscreen`，全部复用已导入的 `WebviewWindow` API
 * （无需新增插件）。Rust 端通过 `app.get_webview_window(label)` 解析窗口，缺失时返回显式的
 * `Err("window not found: {label}")`，这里以 rejected Promise 形式抛出（沿用第三切片的错误传播接缝）。
 *
 * 运行时约束：这些变更需要一个正在活动的窗口（GUI），因此本组接缝在此处只做“编译期”类型校验；
 * 真实效果在 `pnpm dev:tauri` 下运行验证。保持导入零副作用。
 */

/**
 * 设置窗口标题。对应 Rust 命令 `set_window_title`（`WebviewWindow::set_title`）。
 *
 * @param title - 新的窗口标题。
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function setWindowTitle(title: string, label?: string): Promise<void> {
  return invoke<void>("set_window_title", {
    label: label ?? DEFAULT_WINDOW_LABEL,
    title,
  });
}

/**
 * 读取窗口当前标题。对应 Rust 命令 `get_window_title`（`WebviewWindow::title`），是
 * `setWindowTitle` 的配套读取接缝（对齐 Electron `win.getTitle()`）。label 缺省为主窗口。
 *
 * @param label - 目标窗口 label（缺省 `"main"`）。
 */
export function getWindowTitle(label?: string): Promise<string> {
  return invoke<string>("get_window_title", { label: label ?? DEFAULT_WINDOW_LABEL });
}

/**
 * 调整窗口内部尺寸（物理像素）。对应 Rust 命令 `set_window_size`（`WebviewWindow::set_size`，
 * 使用与第九切片 `get_window_size` 相同的无符号像素单位）。
 *
 * @param width - 新的内部宽度（物理像素）。
 * @param height - 新的内部高度（物理像素）。
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function setWindowSize(
  width: number,
  height: number,
  label?: string,
): Promise<void> {
  return invoke<void>("set_window_size", {
    label: label ?? DEFAULT_WINDOW_LABEL,
    width,
    height,
  });
}

/**
 * 移动窗口到指定的物理像素左上角坐标。对应 Rust 命令 `set_window_position`
 * （`WebviewWindow::set_position`，使用与第九切片 `get_window_position` 相同的有符号像素单位）。
 *
 * @param x - 新的左上角 X 坐标（物理像素，可为负值）。
 * @param y - 新的左上角 Y 坐标（物理像素，可为负值）。
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function setWindowPosition(
  x: number,
  y: number,
  label?: string,
): Promise<void> {
  return invoke<void>("set_window_position", {
    label: label ?? DEFAULT_WINDOW_LABEL,
    x,
    y,
  });
}

/**
 * 将窗口在当前显示器上居中。对应 Rust 命令 `center_window`（`WebviewWindow::center`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function centerWindow(label?: string): Promise<void> {
  return invoke<void>("center_window", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * 显式进入或退出全屏。对应 Rust 命令 `set_fullscreen`（`WebviewWindow::set_fullscreen`）。
 * 与第四切片的 `windowToggleFullscreen`（读取后取反）不同，本函数直接设定目标状态。
 *
 * @param fullscreen - `true` 进入全屏，`false` 退出全屏。
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function setFullscreen(fullscreen: boolean, label?: string): Promise<void> {
  return invoke<void>("set_fullscreen", {
    label: label ?? DEFAULT_WINDOW_LABEL,
    fullscreen,
  });
}

/**
 * 查询窗口当前是否处于全屏状态。对应 Rust 命令 `is_fullscreen`（`WebviewWindow::is_fullscreen`）。
 *
 * @param label - 目标窗口 label，缺省为主窗口 `"main"`。
 */
export function isFullscreen(label?: string): Promise<boolean> {
  return invoke<boolean>("is_fullscreen", {
    label: label ?? DEFAULT_WINDOW_LABEL,
  });
}

/**
 * Phase 2 第十一切片：应用路径命令的 TypeScript 接缝（复用 Tauri 内置路径解析器，无需新增插件）。
 *
 * 对应 Rust 命令 `get_home_dir` / `get_temp_dir` / `get_app_data_dir` / `get_app_config_dir`
 * （均通过 `app.path().resolve("", BaseDirectory::X)` 解析）与 `get_exe_path`（通过
 * `std::env::current_exe()` 读取当前可执行文件路径）。Rust 端返回 `Result<String, String>`，
 * 失败时的 `Err(String)` 会在这里以 rejected Promise 的形式抛出（沿用第三切片的错误传播接缝）。
 * 调用方应通过 `.catch`/`try-catch` 处理目录无法解析的情况。保持导入零副作用。
 */

/**
 * 读取当前用户的家目录，例如 `"/home/user"`。对应 Rust 命令 `get_home_dir`
 * （`BaseDirectory::Home`）。
 */
export function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

/**
 * 读取系统临时目录，例如 `"/tmp"`。对应 Rust 命令 `get_temp_dir`（`BaseDirectory::Temp`）。
 */
export function getTempDir(): Promise<string> {
  return invoke<string>("get_temp_dir");
}

/**
 * 读取应用数据目录，例如 `"/home/user/.local/share/com.zcode.app"`。对应 Rust 命令
 * `get_app_data_dir`（`BaseDirectory::AppData`），对齐 Electron 的 `getPath("userData")`。
 */
export function getAppDataDir(): Promise<string> {
  return invoke<string>("get_app_data_dir");
}

/**
 * 读取应用配置目录，例如 `"/home/user/.config/com.zcode.app"`。对应 Rust 命令
 * `get_app_config_dir`（`BaseDirectory::AppConfig`）。
 */
export function getAppConfigDir(): Promise<string> {
  return invoke<string>("get_app_config_dir");
}

/**
 * 读取当前运行可执行文件的绝对路径。对应 Rust 命令 `get_exe_path`
 * （`std::env::current_exe()`，非 BaseDirectory，直接读取）。
 */
export function getExePath(): Promise<string> {
  return invoke<string>("get_exe_path");
}

/**
 * Phase 2 第十三切片：桌面缩放（设置）的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `set_desktop_zoom_level`（`WebviewWindow::set_zoom`）。Electron/Chromium 的缩放
 * 采用对数“等级”（`ZoomIn`/`ZoomOut`/`ResetZoom` 菜单命令与 `getDesktopZoomLevel` 契约），而 Tauri
 * 接收线性缩放因子；Rust 端以纯函数 `factor = 1.2^level` 完成换算（等级 0 == 100% == 因子 1.0）。
 *
 * 偏差说明（已记录，非桩实现）：Tauri 2.12.1 没有缩放 getter，故本切片仅接入设置路径；读取当前等级
 * 需由 `tauriPlatform` 适配器以受管状态跟踪，留待后续切片，不在此伪造。Rust 端 `Err(String)` 在这里
 * 以 rejected Promise 抛出（沿用第三切片的错误传播接缝）。保持导入零副作用。
 *
 * @param label - 目标窗口 label。
 * @param level - 目标缩放等级（Electron 对数单位，`0` 表示 100%）。
 */
export function setTauriDesktopZoomLevel(
  label: string,
  level: number,
): Promise<void> {
  return invoke<void>("set_desktop_zoom_level", { label, level });
}

/**
 * 读取指定窗口当前的桌面缩放等级（Electron 对数单位，`0` 表示 100%）。对应 Rust 命令
 * `get_desktop_zoom_level`（第二十六切片，补齐第十三切片因 Tauri 无缩放 getter 而暂缓的读取）。
 *
 * 因 Tauri 2.12.1 没有缩放 getter，Rust 端通过受管 `ZoomRegistry` 记录 `setTauriDesktopZoomLevel` 应用过的
 * 因子，再经 `zoom_factor_to_level` 换算回等级；从未缩放过返回 `0.0`（初始默认 100%）。label 不存在时
 * Rust 端返回 `Err`，以 rejected Promise 抛出（沿用第三切片错误传播接缝）。
 *
 * @param label - 目标窗口 label。
 */
export function getTauriDesktopZoomLevel(label: string): Promise<number> {
  return invoke<number>("get_desktop_zoom_level", { label });
}

/**
 * Phase 2 第十四切片：窗口装饰附加能力的 TypeScript 接缝（缩放因子、置顶、可调整大小）。
 *
 * 对应 Rust 命令 `get_window_scale_factor` / `is_window_always_on_top` /
 * `set_window_always_on_top` / `is_window_resizable` / `set_window_resizable`，全部复用已导入的
 * `WebviewWindow` getter/setter（无需新增插件或 capability）。Rust 端通过 `require_window(label)`
 * 解析窗口，缺失时返回显式的 `Err("window not found: {label}")`，这里以 rejected Promise 形式抛出
 * （沿用第三切片的错误传播接缝）。
 *
 * 参数命名：Tauri v2 自动把 Rust 的 snake_case 形参映射为 JS 的 camelCase，故 Rust 形参
 * `always_on_top` 在此以 `alwaysOnTop` 传入，`resizable`、`label` 保持不变。运行时需活动 GUI
 * 窗口，因此本组接缝在此处只做编译期类型校验，真实效果在 `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 读取窗口的设备像素比（HiDPI 缩放因子），用于高 DPI 布局。对应 Rust 命令
 * `get_window_scale_factor`（`WebviewWindow::scale_factor`）。
 *
 * @param label - 目标窗口 label。
 */
export function getWindowScaleFactor(label: string): Promise<number> {
  return invoke<number>("get_window_scale_factor", { label });
}

/**
 * 查询窗口当前是否始终置顶。对应 Rust 命令 `is_window_always_on_top`
 * （`WebviewWindow::is_always_on_top`）。
 *
 * @param label - 目标窗口 label。
 */
export function isWindowAlwaysOnTop(label: string): Promise<boolean> {
  return invoke<boolean>("is_window_always_on_top", { label });
}

/**
 * 设置窗口是否始终置顶。对应 Rust 命令 `set_window_always_on_top`
 * （`WebviewWindow::set_always_on_top`）。注意 Rust 形参 `always_on_top` 映射为 `alwaysOnTop`。
 *
 * @param label - 目标窗口 label。
 * @param alwaysOnTop - `true` 置顶，`false` 取消置顶。
 */
export function setWindowAlwaysOnTop(
  label: string,
  alwaysOnTop: boolean,
): Promise<void> {
  return invoke<void>("set_window_always_on_top", { label, alwaysOnTop });
}

/**
 * 查询窗口当前是否可由用户调整大小。对应 Rust 命令 `is_window_resizable`
 * （`WebviewWindow::is_resizable`）。
 *
 * @param label - 目标窗口 label。
 */
export function isWindowResizable(label: string): Promise<boolean> {
  return invoke<boolean>("is_window_resizable", { label });
}

/**
 * 设置窗口是否可由用户调整大小。对应 Rust 命令 `set_window_resizable`
 * （`WebviewWindow::set_resizable`）。
 *
 * @param label - 目标窗口 label。
 * @param resizable - `true` 允许调整大小，`false` 锁定当前尺寸。
 */
export function setWindowResizable(label: string, resizable: boolean): Promise<void> {
  return invoke<void>("set_window_resizable", { label, resizable });
}

/**
 * Phase 2 第十五切片：窗口可见性与防护的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `show_window` / `hide_window` / `set_window_skip_taskbar` /
 * `set_window_focusable` / `set_window_content_protected`，全部复用已导入的 `WebviewWindow`
 * mutator（无需新增插件或 capability）。Rust 端通过 `require_window(label)` 解析窗口，缺失时返回
 * 显式的 `Err("window not found: {label}")`，这里以 rejected Promise 形式抛出（沿用第三切片的错误
 * 传播接缝）。
 *
 * 参数命名：Tauri v2 自动把 Rust 的 snake_case 形参映射为 JS 的 camelCase，故 Rust 形参
 * `is_protected` 在此以 `isProtected` 传入（`protected` 是 Rust 2024 保留字，故 Rust 侧改用
 * `is_protected`）。运行时需活动 GUI 窗口，因此本组接缝在此处只做编译期类型校验，真实效果在
 * `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 显示指定窗口。对应 Rust 命令 `show_window`（`WebviewWindow::show`），对齐 Electron 的 `win.show()`。
 *
 * @param label - 目标窗口 label。
 */
export function showWindow(label: string): Promise<void> {
  return invoke<void>("show_window", { label });
}

/**
 * 隐藏指定窗口。对应 Rust 命令 `hide_window`（`WebviewWindow::hide`），对齐 Electron 的 `win.hide()`。
 *
 * @param label - 目标窗口 label。
 */
export function hideWindow(label: string): Promise<void> {
  return invoke<void>("hide_window", { label });
}

/**
 * 设置窗口是否在任务栏/程序坞中隐藏。对应 Rust 命令 `set_window_skip_taskbar`
 * （`WebviewWindow::set_skip_taskbar`），对齐 Electron 的 `setSkipTaskbar`。
 *
 * @param label - 目标窗口 label。
 * @param skip - `true` 从任务栏隐藏，`false` 显示。
 */
export function setWindowSkipTaskbar(label: string, skip: boolean): Promise<void> {
  return invoke<void>("set_window_skip_taskbar", { label, skip });
}

/**
 * 设置窗口是否可获取键盘焦点。对应 Rust 命令 `set_window_focusable`
 * （`WebviewWindow::set_focusable`），对齐 Electron 的 `setFocusable`。
 *
 * @param label - 目标窗口 label。
 * @param focusable - `true` 允许聚焦，`false` 禁止聚焦。
 */
export function setWindowFocusable(label: string, focusable: boolean): Promise<void> {
  return invoke<void>("set_window_focusable", { label, focusable });
}

/**
 * 开启/关闭窗口内容防护（反截屏）。对应 Rust 命令 `set_window_content_protected`
 * （`WebviewWindow::set_content_protected`），是平台契约 `captureWindowScreenshot` 的反向镜像，
 * 对齐 Electron 的 `setContentProtection`。注意 Rust 形参 `is_protected` 映射为 JS 的 `isProtected`
 * （`protected` 为 Rust 2024 保留字）。
 *
 * @param label - 目标窗口 label。
 * @param isProtected - `true` 排除截屏/录屏，`false` 允许。
 */
export function setWindowContentProtected(
  label: string,
  isProtected: boolean,
): Promise<void> {
  return invoke<void>("set_window_content_protected", { label, isProtected });
}

/**
 * Phase 2 第十六切片：窗口状态补全的 TypeScript 接缝（取消最小化、最小化状态、内部位置、启用状态）。
 *
 * 对应 Rust 命令 `window_unminimize` / `is_window_minimized` / `get_window_inner_position` /
 * `is_window_enabled` / `set_window_enabled`，全部复用已导入的 `WebviewWindow` API（无需新增插件或
 * capability）。Rust 端通过 `require_window(label)` 解析窗口，缺失时返回显式的
 * `Err("window not found: {label}")`，这里以 rejected Promise 形式抛出（沿用第三切片的错误传播接缝）。
 * `get_window_inner_position` 复用第九切片 `get_window_position` 相同的 `{ x, y }` 对象形状（内部客户区
 * 原点 vs 外部边框原点）。运行时需活动 GUI 窗口，因此本组接缝在此处只做编译期类型校验，真实效果在
 * `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 取消最小化（还原）指定窗口。对应 Rust 命令 `window_unminimize`（`WebviewWindow::unminimize`），
 * 对齐 Electron 的从最小化还原。
 *
 * @param label - 目标窗口 label。
 */
export function windowUnminimize(label: string): Promise<void> {
  return invoke<void>("window_unminimize", { label });
}

/**
 * 查询窗口当前是否处于最小化状态。对应 Rust 命令 `is_window_minimized`
 * （`WebviewWindow::is_minimized`）。
 *
 * @param label - 目标窗口 label。
 */
export function isWindowMinimized(label: string): Promise<boolean> {
  return invoke<boolean>("is_window_minimized", { label });
}

/**
 * 读取窗口内部（客户区）位置。对应 Rust 命令 `get_window_inner_position`
 * （`WebviewWindow::inner_position`），返回与 `get_window_position` 相同的 `{ x, y }` 形状。
 *
 * @param label - 目标窗口 label。
 */
export function getWindowInnerPosition(label: string): Promise<{ x: number; y: number }> {
  return invoke<{ x: number; y: number }>("get_window_inner_position", { label });
}

/**
 * 查询窗口当前是否允许用户交互。对应 Rust 命令 `is_window_enabled`
 * （`WebviewWindow::is_enabled`）。
 *
 * @param label - 目标窗口 label。
 */
export function isWindowEnabled(label: string): Promise<boolean> {
  return invoke<boolean>("is_window_enabled", { label });
}

/**
 * 设置窗口是否允许用户交互。对应 Rust 命令 `set_window_enabled`
 * （`WebviewWindow::set_enabled`）。
 *
 * @param label - 目标窗口 label。
 * @param enabled - `true` 允许交互，`false` 屏蔽交互。
 */
export function setWindowEnabled(label: string, enabled: boolean): Promise<void> {
  return invoke<void>("set_window_enabled", { label, enabled });
}

/**
 * Phase 2 第十七切片：边框几何与全局光标的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `get_window_outer_size` / `get_cursor_position`，全部复用已导入的
 * `WebviewWindow` API（无需新增插件或 capability）。Rust 端通过 `require_window(label)` 解析窗口，
 * 缺失时返回显式的 `Err("window not found: {label}")`，这里以 rejected Promise 形式抛出（沿用第三
 * 切片的错误传播接缝）。运行时需活动 GUI 窗口，因此本组接缝在此处只做编译期类型校验，真实读取在
 * `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 读取窗口外部（含边框）尺寸。对应 Rust 命令 `get_window_outer_size`
 * （`WebviewWindow::outer_size`），复用第九切片 `getWindowSize` 相同的 `{ width, height }` 形状；
 * 与 `get_window_size`（内部客户区）不同，本函数含窗口边框，对齐 Electron 的 `getBounds()`。
 *
 * @param label - 目标窗口 label。
 */
export function getWindowOuterSize(label: string): Promise<TauriWindowSize> {
  return invoke<TauriWindowSize>("get_window_outer_size", { label });
}

/**
 * 读取桌面全局光标位置（物理像素，亚像素浮点）。对应 Rust 命令 `get_cursor_position`
 * （`WebviewWindow::cursor_position`），映射 Rust 端 `CursorPosition { x, y }`；x/y 为 `f64`，
 * 是 OS 级全局光标（非窗口相对），跨左上排布的副屏时可为负值。
 *
 * @param label - 目标窗口 label（用于触达窗口的光标 API，返回值为桌面全局光标）。
 */
export function getCursorPosition(label: string): Promise<{ x: number; y: number }> {
  return invoke<{ x: number; y: number }>("get_cursor_position", { label });
}

/**
 * Phase 2 第十八切片：补齐既有 Rust 命令缺失的 TS 接缝（主题 get/set、sidecar 启动）。
 *
 * 这三个命令（slice 12 的 `get_window_theme` / `set_window_theme` 与 sidecar PoC 的
 * `spawn_sidecar_echo`）此前只在 Rust 侧落地，`tauriBridge.ts` 一直没有对应包装，导致渲染端无法调用，
 * 命令⇄接缝出现漂移。本次补齐使「每个 `#[tauri::command]` 都有一个 `invoke` 包装」这一不变式重新成立；
 * 该不变式由 `tauri-port/test/layer-a/a5-contract.test.ts` 静态校验固化。
 */

/**
 * 读取指定窗口当前的明暗主题。对应 Rust 命令 `get_window_theme`（`WebviewWindow::theme`）。
 * Rust 端把 `tauri::Theme` 映射为 `"light"` / `"dark"`（未知主题回退 `"unknown"`）。缺失窗口或 OS
 * 无法读取时返回 `Err(String)`，这里以 rejected Promise 抛出。
 *
 * @param label - 目标窗口 label。
 */
export function getWindowTheme(label: string): Promise<string> {
  return invoke<string>("get_window_theme", { label });
}

/**
 * 设置或清除指定窗口的主题。对应 Rust 命令 `set_window_theme`（`WebviewWindow::set_theme`）。
 *
 * @param label - 目标窗口 label。
 * @param theme - `"light"` / `"dark"`；传 `null` 清除显式覆盖（跟随系统）。Rust 形参 `theme:
 *   Option<String>`，`null`/缺省即映射为 `None`。未知字符串在 Rust 侧返回 `Err("invalid theme")`。
 */
export function setWindowTheme(label: string, theme: string | null): Promise<void> {
  return invoke<void>("set_window_theme", { label, theme });
}

/**
 * 启动内置的 `zcode-echo` sidecar 子进程（sidecar-runtime PoC）。对应 Rust 命令
 * `spawn_sidecar_echo`（`tauri-plugin-shell` 的 externalBin）。
 *
 * @param port - 通过 `ZCODE_WS_PORT` 传给 sidecar 的回环 WebSocket 端口。
 * @returns 被拉起子进程的 OS pid（Rust 端 `Result<u32, String>`，失败时为 rejected Promise）。
 */
export function spawnTauriSidecarEcho(port: number): Promise<number> {
  return invoke<number>("spawn_sidecar_echo", { port });
}

/**
 * 终止指定 pid 的 sidecar 子进程（Phase 2 第二十切片）。对应 Rust 命令 `kill_sidecar`：从受管的
 * `SidecarRegistry` 按 pid 取出并消耗 `CommandChild`，调用其 `kill()`。sidecar 不会随主进程自动回收
 * （不同于 Electron 的 utilityProcess），必须显式终止以避免孤儿进程。pid 未注册（已杀或从未启动）时
 * Rust 端返回 `Err("no such sidecar")`，以 rejected Promise 形式抛出（沿用第三切片错误传播接缝）。
 *
 * @param pid - `spawnTauriSidecarEcho` 返回的 OS 进程号。
 */
export function killTauriSidecar(pid: number): Promise<void> {
  return invoke<void>("kill_sidecar", { pid });
}

/**
 * 启动 `zcode-echo` sidecar 并返回它实际绑定的临时端口（Phase 2 第三十一切片：动态端口发现）。对应 Rust
 * 命令 `spawn_sidecar_echo_discover_port`。与固定端口的 `spawnTauriSidecarEcho(port)` 不同：这里注入
 * `ZCODE_WS_PORT=0` 让 OS 选择空闲端口，读取子进程 stdout 的 `ZCODE_WS_READY <port>` 握手行解析出真实端口，
 * 是并行多实例 agent 所需的传输基础（固定端口无法支持并发实例）。子进程仍登记到 `SidecarRegistry`，可用
 * `killTauriSidecar(pid)` 终止。sidecar 崩溃或提前关闭 stdout 时 Rust 端返回 `Err`（不会悬挂）。运行时需
 * 已构建的 externalBin + 活动窗口，真实效果在 `pnpm dev:tauri` 下验证。
 *
 * @returns sidecar 绑定的端口号（Rust 端 `Result<u32, String>`，失败为 rejected Promise）。
 */
export function spawnTauriSidecarDiscoverPort(): Promise<number> {
  return invoke<number>("spawn_sidecar_echo_discover_port");
}

/**
 * Phase 2 第三十三切片：桌面缩放变更事件（推送通道）的 TypeScript 接缝。
 *
 * 这是首个 Rust→渲染端「事件推送」通道，验证 Tauri 原生事件机制（`app.emit` ⇄
 * `@tauri-apps/api/event` 的 `listen`，均为 core，无需新增插件/依赖），为后续 `on*` 事件族打样。
 * Rust 端 `set_desktop_zoom_level` 在应用并记录缩放后广播 `ZOOM_CHANGED_EVENT`，载荷为
 * `DesktopZoomState = { zoomLevel: number }`（与平台契约 getDesktopZoomLevel 返回形状一致）。
 * `ZOOM_CHANGED_EVENT` 字面量与 Rust `commands.rs` 的同名常量必须逐字一致，由 a5 契约守卫校验防漂移。
 * 需运行时活动窗口才有真实推送，此处只做编译期类型校验，真实效果在 `pnpm dev:tauri` 下验证。
 */
export const ZOOM_CHANGED_EVENT = "zcode:desktop-zoom-changed";

/** 桌面缩放状态（与 `packages/shared` 的 `DesktopZoomState` 形状一致）。 */
export interface TauriDesktopZoomState {
  zoomLevel: number;
}

/**
 * 订阅桌面缩放变更事件。对应 Rust 广播 `ZOOM_CHANGED_EVENT`（`set_desktop_zoom_level` 触发）。
 *
 * @param handler - 每次缩放变更时以 `{ zoomLevel }` 调用。
 * @returns 解析为退订函数；调用它停止监听。
 */
export function listenTauriDesktopZoomChanged(
  handler: (state: TauriDesktopZoomState) => void,
): Promise<UnlistenFn> {
  return listen<TauriDesktopZoomState>(ZOOM_CHANGED_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * Phase 2 第二十一切片：窗口边框与交互的 TypeScript 接缝（装饰、点击穿透、最小/最大尺寸设置与清除）。
 *
 * 对应 Rust 命令 `set_window_decorations` / `set_window_ignore_cursor_events` /
 * `set_window_min_size` / `set_window_max_size` / `clear_window_min_size` / `clear_window_max_size`，
 * 全部复用已导入的 `WebviewWindow` mutator（无需新增插件或 capability）。所有 Rust 形参均为单词
 * （decorations/ignore/width/height/label），camelCase 不变式自然满足（由 a5 契约守卫校验）。运行时需
 * 活动 GUI 窗口，因此本组接缝在此处只做编译期类型校验，真实效果在 `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 开/关窗口原生标题栏与边框。对应 Rust 命令 `set_window_decorations`
 * （`WebviewWindow::set_decorations`），对齐 Electron 的 `setFrame`。
 *
 * @param label - 目标窗口 label。
 * @param decorations - `true` 显示原生边框，`false` 无边框。
 */
export function setWindowDecorations(
  label: string,
  decorations: boolean,
): Promise<void> {
  return invoke<void>("set_window_decorations", { label, decorations });
}

/**
 * 设置窗口是否点击穿透（鼠标事件透传到下层窗口）。对应 Rust 命令
 * `set_window_ignore_cursor_events`（`WebviewWindow::set_ignore_cursor_events`），用于浮层/提示窗。
 *
 * @param label - 目标窗口 label。
 * @param ignore - `true` 忽略（穿透）鼠标事件，`false` 捕获。
 */
export function setWindowIgnoreCursorEvents(
  label: string,
  ignore: boolean,
): Promise<void> {
  return invoke<void>("set_window_ignore_cursor_events", { label, ignore });
}

/**
 * 设置窗口最小尺寸（物理像素）。对应 Rust 命令 `set_window_min_size`
 * （`WebviewWindow::set_min_size(Some(PhysicalSize))`）。用 `clearWindowMinSize` 解除约束。
 *
 * @param label - 目标窗口 label。
 * @param width - 最小内部宽度（物理像素）。
 * @param height - 最小内部高度（物理像素）。
 */
export function setWindowMinSize(
  label: string,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>("set_window_min_size", { label, width, height });
}

/**
 * 设置窗口最大尺寸（物理像素）。对应 Rust 命令 `set_window_max_size`
 * （`WebviewWindow::set_max_size(Some(PhysicalSize))`）。用 `clearWindowMaxSize` 解除约束。
 *
 * @param label - 目标窗口 label。
 * @param width - 最大内部宽度（物理像素）。
 * @param height - 最大内部高度（物理像素）。
 */
export function setWindowMaxSize(
  label: string,
  width: number,
  height: number,
): Promise<void> {
  return invoke<void>("set_window_max_size", { label, width, height });
}

/**
 * 清除窗口最小尺寸约束。对应 Rust 命令 `clear_window_min_size`
 * （`WebviewWindow::set_min_size(None)`）。
 *
 * @param label - 目标窗口 label。
 */
export function clearWindowMinSize(label: string): Promise<void> {
  return invoke<void>("clear_window_min_size", { label });
}

/**
 * 清除窗口最大尺寸约束。对应 Rust 命令 `clear_window_max_size`
 * （`WebviewWindow::set_max_size(None)`）。
 *
 * @param label - 目标窗口 label。
 */
export function clearWindowMaxSize(label: string): Promise<void> {
  return invoke<void>("clear_window_max_size", { label });
}

/**
 * Phase 2 第二十二切片：窗口背景色的 TypeScript 接缝（设置 RGBA / 清除）。
 *
 * 对应 Rust 命令 `set_window_background_color` / `clear_window_background_color`
 * （`WebviewWindow::set_background_color`），对齐 Electron 的 `setBackgroundColor`。四个通道为独立
 * 单词形参（red/green/blue/alpha，均为 0..=255 的 number，Rust 侧反序列化为 `u8` 组成
 * `tauri::webview::Color(r,g,b,a)`），故 camelCase 不变式自然满足。运行时需活动 GUI 窗口，本组接缝在此
 * 只做编译期类型校验，真实效果在 `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/**
 * 设置窗口背景色（RGBA）。对应 Rust 命令 `set_window_background_color`。用于加载期与透明区域底色。
 *
 * @param label - 目标窗口 label。
 * @param red - 红通道 0..=255。
 * @param green - 绿通道 0..=255。
 * @param blue - 蓝通道 0..=255。
 * @param alpha - Alpha 通道 0..=255（255 为不透明）。
 */
export function setWindowBackgroundColor(
  label: string,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): Promise<void> {
  return invoke<void>("set_window_background_color", {
    label,
    red,
    green,
    blue,
    alpha,
  });
}

/**
 * 清除窗口背景色覆盖，恢复系统/WebView 默认底色。对应 Rust 命令
 * `clear_window_background_color`（`set_background_color(None)`）。
 *
 * @param label - 目标窗口 label。
 */
export function clearWindowBackgroundColor(label: string): Promise<void> {
  return invoke<void>("clear_window_background_color", { label });
}

/**
 * Phase 2 第二十三切片：macOS 全空间显示 + 光标锁定/可见性的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `set_window_visible_on_all_workspaces` / `set_window_cursor_grab` /
 * `set_window_cursor_visible`，均为单个 bool 的 `WebviewWindow` mutator（无需新增插件或 capability）。
 * 注意 Rust 形参 `visible_on_all_workspaces` 映射为 JS 的 `visibleOnAllWorkspaces`（camelCase，由 a5
 * 契约守卫校验）。运行时需活动 GUI 窗口，本组接缝在此只做编译期类型校验，真实效果在 `pnpm dev:tauri`
 * 下验证。保持导入零副作用。
 */

/**
 * 设置窗口是否在所有 macOS Space 上显示（对齐 Electron `setVisibleOnAllWorkspaces`）。对应 Rust 命令
 * `set_window_visible_on_all_workspaces`。非 macOS 平台为 no-op。
 *
 * @param label - 目标窗口 label。
 * @param visibleOnAllWorkspaces - `true` 在所有工作区显示，`false` 仅当前工作区。
 */
export function setWindowVisibleOnAllWorkspaces(
  label: string,
  visibleOnAllWorkspaces: boolean,
): Promise<void> {
  return invoke<void>("set_window_visible_on_all_workspaces", {
    label,
    visibleOnAllWorkspaces,
  });
}

/**
 * 锁定或释放窗口内的系统光标（指针锁定，用于捕获类交互）。对应 Rust 命令 `set_window_cursor_grab`
 * （`WebviewWindow::set_cursor_grab`）。
 *
 * @param label - 目标窗口 label。
 * @param grab - `true` 将光标约束在窗口内，`false` 释放。
 */
export function setWindowCursorGrab(label: string, grab: boolean): Promise<void> {
  return invoke<void>("set_window_cursor_grab", { label, grab });
}

/**
 * 显示或隐藏窗口上的系统光标（媒体空闲/全屏时隐藏，交互时恢复）。对应 Rust 命令
 * `set_window_cursor_visible`（`WebviewWindow::set_cursor_visible`）。
 *
 * @param label - 目标窗口 label。
 * @param visible - `true` 显示光标，`false` 隐藏。
 */
export function setWindowCursorVisible(
  label: string,
  visible: boolean,
): Promise<void> {
  return invoke<void>("set_window_cursor_visible", { label, visible });
}

/**
 * Phase 2 第二十四切片：应用生命周期（重启 / 退出）的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `relaunch_app` / `exit_app`，直接调用核心 `AppHandle::restart` / `AppHandle::exit`
 * （无需新增插件或 capability）。对齐 Electron 的 `app.relaunch()` / `app.quit()`，服务于真实菜单命令
 * `DesktopCommandIds.RelaunchApp` 及退出需求。注意：`relaunch_app` 触发进程重建，重启后运行时消失，
 * 该 `invoke` 的 Promise 不会 resolve（与 Electron 重启行为一致，非桩实现）。参数 `code` 为单词，
 * camelCase 不变式自然满足。保持导入零副作用。
 */

/**
 * 重启应用进程（终止后重新拉起）。对应 Rust 命令 `relaunch_app`（`AppHandle::restart`）。
 * 调用成功后进程被重建，返回的 Promise 不会 resolve。
 */
export function relaunchTauriApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

/**
 * 以给定退出码结束应用进程。对应 Rust 命令 `exit_app`（`AppHandle::exit`）。
 *
 * @param code - 进程退出码（0 表示正常退出）。
 */
export function exitTauriApp(code: number): Promise<void> {
  return invoke<void>("exit_app", { code });
}

/**
 * Phase 2 第二十五切片：目录（文件夹）选择器的 TypeScript 接缝，对齐平台契约的
 * `selectDirectory`（打开工作区流程）。
 *
 * 对应 Rust 命令 `select_directory`（复用已装的 `tauri-plugin-dialog` 的 `blocking_pick_folder(s)`，
 * 无新增依赖）。第五切片只有文件选择器 `showOpenDialog`，缺少目录选择；本切片补齐目录选择，并把单选
 * 归一化为 `string[]`（`multiple` 为真时可多选）。目录选择不带文件类型过滤器。用户取消返回 `null`，
 * 非错误。Rust 端 `Err(String)` 以 rejected Promise 抛出（沿用第三切片错误传播接缝）。运行时需活动 GUI
 * 对话框，本接缝在此只做编译期类型校验，真实效果在 `pnpm dev:tauri` 下验证。保持导入零副作用。
 *
 * @param multiple - 是否允许多选目录，缺省单选。
 */
export function selectDirectory(
  multiple = false,
): Promise<string[] | null> {
  return invoke<string[] | null>("select_directory", { multiple });
}

/**
 * Phase 2 第十九切片：显示器信息（多屏 / HiDPI）的 TypeScript 接缝。
 *
 * 对应 Rust 命令 `get_window_current_monitor` / `get_primary_monitor` / `get_available_monitors`，
 * 全部复用已导入的 `WebviewWindow` 显示器查询 API（无需新增插件或 capability），对齐 Electron 的
 * `screen.getAllDisplays()` / `getPrimaryDisplay()`。Rust 端通过 `require_window(label)` 解析窗口，
 * 再把 `tauri::Monitor` 经纯映射函数 `monitor_to_info` 转为 `MonitorInfo`。Rust 端返回 `Result<..,
 * String>`，缺失窗口或 OS 无法枚举显示器时以 rejected Promise 抛出（沿用第三切片的错误传播接缝）。
 *
 * 字段命名：Rust `MonitorInfo` 带 `#[serde(rename_all = "camelCase")]`，故返回对象的缩放字段为
 * `scaleFactor`（camelCase）而非 snake_case，以契合桥接层的 camelCase 不变式（由 a5 契约守卫校验）。
 * 运行时需活动 GUI 窗口与真实 OS 显示器，因此本组接缝在此处只做编译期类型校验，真实枚举在
 * `pnpm dev:tauri` 下验证。保持导入零副作用。
 */

/** 单个显示器（monitor）的序列化形状；字段名与 Rust `MonitorInfo` 的 camelCase serde 输出一致。 */
export interface TauriMonitor {
  /** OS 提供的可读名称，缺失时为 `null`。 */
  name: string | null;
  /** 物理像素尺寸，复用第九切片的 `TauriWindowSize` 形状。 */
  size: TauriWindowSize;
  /** 物理像素原点（左上角）在虚拟桌面上的位置。 */
  position: { x: number; y: number };
  /** 该显示器的设备像素比（HiDPI 缩放因子）；Rust 字段 `scale_factor` 经 serde 重命名为 camelCase。 */
  scaleFactor: number;
}

/**
 * 读取承载指定窗口的显示器，OS 无返回时为 `null`。对应 Rust 命令 `get_window_current_monitor`
 * （`WebviewWindow::current_monitor`）。
 *
 * @param label - 目标窗口 label。
 */
export function getTauriCurrentMonitor(label: string): Promise<TauriMonitor | null> {
  return invoke<TauriMonitor | null>("get_window_current_monitor", { label });
}

/**
 * 读取主显示器。对应 Rust 命令 `get_primary_monitor`（`WebviewWindow::primary_monitor`）。
 *
 * @param label - 目标窗口 label（用于触达窗口的显示器查询）。
 */
export function getTauriPrimaryMonitor(label: string): Promise<TauriMonitor | null> {
  return invoke<TauriMonitor | null>("get_primary_monitor", { label });
}

/**
 * 枚举指定窗口所在桌面的全部显示器。对应 Rust 命令 `get_available_monitors`
 * （`WebviewWindow::available_monitors`），对齐 Electron 的 `screen.getAllDisplays()`。
 *
 * @param label - 目标窗口 label。
 */
export function getTauriAvailableMonitors(label: string): Promise<TauriMonitor[]> {
  return invoke<TauriMonitor[]>("get_available_monitors", { label });
}
