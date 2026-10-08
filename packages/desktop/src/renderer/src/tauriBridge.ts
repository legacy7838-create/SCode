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
