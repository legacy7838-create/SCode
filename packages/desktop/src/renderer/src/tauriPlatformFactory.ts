import type { IPlatformService } from "@zcode/shared";

import { bootstrapTauriPlatform, createTauriPlatformSubset } from "./tauriPlatform.js";
import type { TauriPlatformSubset } from "./tauriPlatform.js";

/**
 * Tauri 运行时平台工厂 — 渲染端接缝（`main.tsx` 在 `isTauriRuntime()` 下选用）。
 *
 * 这是一个 **降级启动平台**，不是功能对等实现：已有真实、已验证 Tauri command 支撑的方法走
 * `createTauriPlatformSubset()`；其余方法返回安全的惰性值，让渲染端能够 MOUNT 并渲染，而不是因为
 * 缺失的宿主能力直接崩溃。
 *
 * 诚实的范围说明：下面这些惰性实现明确表示“尚未移植到 Tauri shell”——无副作用的 `void` 方法、
 * 返回空/false/null 的 getter、以及永不触发的 `on*` disposer。它们**不是**假装能工作的 stub：
 * 调用一个未移植的功能不会有任何效果，直到它被真正移植。真正有支撑的方法才是事实来源。
 * Electron 已从本工程移除，Tauri 是唯一的桌面运行时。
 *
 * ## 类型安全（关键设计）
 *
 * 历史缺陷：这里曾经用 `as unknown as IPlatformService` 收尾。它把「工厂漏掉了接口方法」这件事
 * 对 TypeScript 完全隐藏起来 —— 当时实际返回 76 个键，而 `IPlatformService` 有 104 个方法，
 * 缺的那 28 个（`openInEditor`、`getApplicationIcon`、`onOpenBrowserUrl` 等）调用时直接
 * `TypeError: ... is not a function`，编译器却一声不吭。
 *
 * 现在改为 {@link UnportedPlatform}：用 `-?` 剥掉可选性，强制每个未移植成员都必须显式出现。
 * 一旦 `IPlatformService` 新增方法而这里漏写，`pnpm typecheck` 立刻报错；一旦 subset 的 `Pick`
 * 扩张、某个方法变成真实 command，`UnportedPlatform` 也必须同步交出它，否则同样报错。
 * 合并 `{ ...unported, ...subset }` 的类型即为 `IPlatformService`，因此结尾不再需要任何断言。
 *
 * @see ../../tauri-port/GO-NO-GO.md —— 剩余接口族的阻塞决策（D1 浏览器 / D2 更新器 / D3 目标 OS / D4 体积动机）。
 */

/** 尚未移植到 Tauri command 的成员：可空的必须写全，避免缺键在运行期才炸。 */
export type UnportedPlatform = {
  -readonly [K in Exclude<
    keyof IPlatformService,
    keyof TauriPlatformSubset
  >]-?: IPlatformService[K];
};

/** 未移植能力的统一错误标记，便于 UI / 日志区分「不支持」与「真失败」。 */
const NOT_SUPPORTED = "not-supported-in-tauri-shell";

/** 一个什么都不做的 `() => void` disposer —— 用于尚未接上 emit 源的 `on*` 订阅。 */
const inertDisposer = (): (() => void) => () => {};

/**
 * 构造降级的 Tauri 平台。调用方**必须**先 `await bootstrapTauriPlatform()`
 * （或直接用 {@link createTauriPlatformAsync}），否则同步 getter（如 `getDeviceId`）读不到值。
 *
 * @returns 完整满足 `IPlatformService` 的平台对象：有 command 支撑的成员是真实实现，
 *   其余为显式惰性实现。
 */
export function createTauriPlatform(): IPlatformService {
  // 触发同步 getter 预取（blocker #7）。fire-and-forget：main.tsx 里的异步 MessagePort 等待
  // 给它留出在首次同步读取（getDeviceId）之前完成解析的时间。
  //
  // 修复依据：这里原本是裸的 `void bootstrapTauriPlatform()`。bootstrap 会调用 Tauri 的
  // `invoke`，而它在 IPC 未就绪（窗口尚未建立、runtime 未探测成功）时会 reject。裸 `void`
  // 丢弃了那个 Promise，于是失败变成 **unhandled rejection**——在渲染进程里会污染全局错误
  // 通道并可能让整个 renderer 挂掉。预取本质是 best-effort：失败时 `deviceIdCache` 保持
  // `null`，`getDeviceId()` 会退化为空字符串（tauriPlatform.ts:200），功能降级而非崩溃，
  // 因此这里显式吞掉错误。
  void bootstrapTauriPlatform().catch(() => {
    // 故意不重抛：见上。getDeviceId 的空字符串退化就是这里的兜底语义。
  });
  const subset = createTauriPlatformSubset();

  const unported: UnportedPlatform = {
    // --- 平台能力标志 ---
    // 文件选择框在 Tauri 下返回宿主绝对路径（show_save_dialog / open 对话框由 Rust 提供），
    // 与 Desktop 语义一致，因此显式置 true 而不是留空。
    canSelectFilePath: true,
    isLocalDevelopmentRuntime: false,

    // --- 早期启动期的读取（Electron 下曾因 window.zcode.* 缺失而崩掉渲染端） ---
    // printToPDF 在 Tauri webview 尚不可用（见 PRINT-PDF-SPIKE.md），返回失败结果。
    printPageToPdf: async () => ({
      success: false,
      error: "print_not_supported_in_tauri_shell",
    }),
    getDesktopWindowChromeState: async () => ({
      isMaximized: false,
      macOSMajorVersion: null,
      supportsNativeRoundedCorners: false,
    }),
    onDesktopWindowChromeStateChanged: inertDisposer,
    getWindowControlsOverlayMetrics: () => null,
    onWindowControlsOverlayChanged: inertDisposer,

    // --- main 进程簿记类 fire-and-forget：shell 注册表移植前惰性 ---
    notifyRendererReady: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    syncAppSettings: () => {},
    setShortcutRecordingActive: () => {},
    registerOAuthState: () => {},

    // --- emit 源尚未接线的 `on*` 订阅（deep link / 菜单 / 更新器） ---
    onOAuthCallback: inertDisposer,
    onPaymentCallback: inertDisposer,
    onShareImport: inertDisposer,
    onOpenFeedbackDialog: inertDisposer,
    onOpenTicketsPanel: inertDisposer,
    onFocusTab: inertDisposer,
    onNewTab: inertDisposer,
    onNewTask: inertDisposer,
    onOpenWorkspace: inertDisposer,
    onOpenWorkspacePath: inertDisposer,
    onCloseActiveContextRequest: inertDisposer,
    onSettingsChanged: inertDisposer,
    onApplicationLocaleChanged: inertDisposer,
    onTaskNotificationClick: inertDisposer,
    onRemoteConnectionLog: inertDisposer,
    onRemoteSessionClosed: inertDisposer,
    onBotRemoteWorkspaceReconnected: inertDisposer,

    // --- 配置 / 远程 / 浏览器 / 更新器族：移植前的安全默认值 ---
    openFeedback: async () => {},
    openCommunity: async () => {},
    canOpenCommunity: async () => false,
    // 远程下载器（saveFile 的 URL 变体）必须整块移植其 SSRF 防护不变量才能开启，
    // 数据面半移植是禁止的安全回退，因此这里整体拒绝。见 SAVE-FILE-SPIKE.md。
    saveFile: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),
    getPathForFile: () => null,
    createLocalMediaPreviewUrl: () => "",
    isDockerAvailable: async () => false,
    listWSLDistros: async () => [],
    listDockerContainers: async () => [],
    listSSHConfigAliases: async () => [],
    disposeRemoteSession: async () => {},
    cancelPendingRemoteConnection: async () => {},
    connectRemote: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),
    bindRemoteWorkspaceSessionContext: async () => {},
    // 编辑器枚举为空会让 UI 隐藏「在编辑器中打开」入口。注意：一旦这里开始返回真实编辑器，
    // `openInEditor` 必须同一个切片一起移植，否则 UI 会调用到惰性实现并拿到不支持的结果。
    getInstalledEditors: async () => [],
    openInEditor: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),
    getApplicationIcon: async () => null,
    executeDesktopCommand: async () => undefined,
    setApplicationLocale: async () => {},
    exportLogs: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),
    captureWindowScreenshot: async () => null,

    // --- MCP 宿主目录读写：Tauri shell 尚未暴露宿主目录访问 ---
    loadMcpFromUserDirectory: async () => ({
      servers: [],
    }),
    saveMcpToUserDirectory: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),
    migrateLegacyCommonMcp: async () => ({
      servers: {},
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
    }),

    // --- 内置浏览器（D1）：Tauri 侧没有对等 CDP/webview 分区能力，整族惰性 ---
    onOpenBrowserUrl: inertDisposer,
    onBrowserViewReady: inertDisposer,
    onBrowserViewOperation: inertDisposer,
    onBrowserViewVisibility: inertDisposer,
    onBrowserViewViewportChanged: inertDisposer,
    onBrowserViewScreenshotSurfacePrepare: inertDisposer,
    onBrowserViewScreenshotSurfaceRelease: inertDisposer,
    onBrowserViewCloseTab: inertDisposer,
    onBrowserViewSuspend: inertDisposer,
    onBrowserViewRestore: inertDisposer,
    browserViewScreenshotSurfaceReady: () => {},
    browserViewAttachGuest: async () => ({
      ok: false,
      reason: "not-webview",
      recoveryRequested: true,
    }),
    browserViewDetachGuest: async () => false,
    browserViewCloseTab: async () => {},
    browserViewReportResidency: async () => {},
    browserViewSuspendReady: async () => {},
    browserViewEnsureResident: async () => {},
    browserViewRestoreTabs: async () => [],
    browserViewUpdateViewport: async () => {},
    importChromeBrowserData: async () => ({
      success: false,
      // 惰性实现不触碰宿主 Chrome Profile，因此各项计数一律归零；
      // `error` 用枚举里的既有取值表示「本机未发现可用 Profile」，
      // 而不是任意字符串——该字段是被 UI 按码分支的。
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "chrome_profile_not_found",
    }),
    clearEmbeddedBrowserData: async () => ({
      success: false,
      error: NOT_SUPPORTED,
    }),

    // --- 更新器（D2：tauri-plugin-updater 未安装）：惰性 ---
    // 修复依据：`UpdateStatePayload` 是以 `kind` 为判别式的联合，而旧实现返回的是
    // `{ status: "idle" }`——`status` 根本不在该类型里。调用方读 `.kind` 只会拿到
    // `undefined`，更新状态 UI 会静默失效。这里按真实判别式返回 idle。
    getUpdateState: async () => ({ kind: "idle", enabled: false }),
    onUpdateReady: inertDisposer,
    onUpdateCheckResult: inertDisposer,
    onUpdateStateChanged: inertDisposer,
    downloadUpdate: async () => {},
    cancelUpdateDownload: async () => {},
    quitAndInstallUpdate: async () => {},
    openUpdateStatusWindow: async () => {},
    getAutoUpdatePreferences: async () => ({
      autoDownloadAndInstallUpdates: false,
    }),
    setAutoDownloadAndInstallUpdates: async () => {},
    skipUpdateVersion: async () => {},
    onPostUpdateReleaseNotes: inertDisposer,
    acknowledgePostUpdateReleaseNotes: async () => {},
    getDesktopSessionActivity: async () => ({
      runningAgentSessionCount: 0,
    }),
    getZCodeStdioTapDevState: async () => ({
      enabled: false,
      visible: false,
      logDir: "",
      statePath: "",
    }),
  };

  // 有真实 command 支撑的成员在键冲突时胜出。
  // 类型上 `UnportedPlatform & TauriPlatformSubset` 恰好等于 `IPlatformService`，
  // 因此这里不需要任何 `as` 断言——漏写方法会由 UnportedPlatform 的 `-?` 在编译期拦下。
  return { ...unported, ...subset };
}

/**
 * await-init-before-expose：先填充同步 getter 缓存（blocker #7），再返回平台。
 * `main.tsx` 在 `isTauriRuntime()` 下应当使用这个入口。
 *
 * @returns 已完成 bootstrap 的 `IPlatformService`。
 */
export async function createTauriPlatformAsync(): Promise<IPlatformService> {
  await bootstrapTauriPlatform();
  return createTauriPlatform();
}
