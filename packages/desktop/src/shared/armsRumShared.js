import { mapZCodeEnvToArmsRumEnv, ZCODE_ARMS_RUM_ENDPOINT, ZCODE_VERSION, } from "@zcode/shared";
/** The `browserCollectors` initialized in the main process, injected via autoInject into the renderer's RumSDK.init(collectors) */
export const ARMS_BROWSER_COLLECTORS = {
    perf: true,
    webvitals: true,
    exception: true,
    whiteScreen: true,
    api: true,
    staticResource: true,
    // Turn on click to collect user behavior; the interaction on the desktop is intensive, the reporting volume and noise will increase, and you need to pay attention to ARMS usage
    click: true,
    longTask: true,
};
/** ARMS page name resolution: one shared rule for `file://` and dev-server URLs, used by both the main process's parseViewName and the renderer */
export function parseArmsViewName(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === "file:") {
            const fileName = parsed.pathname.split("/").pop() ?? "index.html";
            return fileName.replace(/\.html$/i, "") || "index";
        }
        const path = parsed.pathname || "/";
        return path.length > 120 ? `${path.slice(0, 120)}…` : path;
    }
    catch {
        return url.length > 120 ? `${url.slice(0, 120)}…` : url;
    }
}
/** Renderer Browser SDK init configuration (aligned with the main process endpoint/env/version) */
export function buildArmsBrowserInitConfig(runtimeEnv) {
    return {
        enable: true,
        version: ZCODE_VERSION,
        endpoint: ZCODE_ARMS_RUM_ENDPOINT,
        env: mapZCodeEnvToArmsRumEnv(runtimeEnv),
        sessionConfig: {
            sampleRate: 1,
        },
        spaMode: false,
        parseViewName: parseArmsViewName,
        collectors: { ...ARMS_BROWSER_COLLECTORS },
    };
}
//# sourceMappingURL=armsRumShared.js.map