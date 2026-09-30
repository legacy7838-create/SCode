import { type ZCodeRuntimeEnv } from "@zcode/shared";
/** The `browserCollectors` initialized in the main process, injected via autoInject into the renderer's RumSDK.init(collectors) */
export declare const ARMS_BROWSER_COLLECTORS: {
    readonly perf: true;
    readonly webvitals: true;
    readonly exception: true;
    readonly whiteScreen: true;
    readonly api: true;
    readonly staticResource: true;
    readonly click: true;
    readonly longTask: true;
};
/** ARMS page name resolution: one shared rule for `file://` and dev-server URLs, used by both the main process's parseViewName and the renderer */
export declare function parseArmsViewName(url: string): string;
/** Renderer Browser SDK init configuration (aligned with the main process endpoint/env/version) */
export declare function buildArmsBrowserInitConfig(runtimeEnv: ZCodeRuntimeEnv): {
    enable: boolean;
    version: string;
    endpoint: string;
    env: import("@zcode/shared").ArmsRumEnv;
    sessionConfig: {
        sampleRate: number;
    };
    spaMode: false;
    parseViewName: typeof parseArmsViewName;
    collectors: {
        perf: true;
        webvitals: true;
        exception: true;
        whiteScreen: true;
        api: true;
        staticResource: true;
        click: true;
        longTask: true;
    };
};
//# sourceMappingURL=armsRumShared.d.ts.map