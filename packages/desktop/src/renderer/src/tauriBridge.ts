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
