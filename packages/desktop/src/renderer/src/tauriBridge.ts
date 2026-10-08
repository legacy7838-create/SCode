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
