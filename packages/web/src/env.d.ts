declare module "*.css";
declare module "@zcode/ui/styles.css";

interface ImportMetaEnv {
  // This file declares the Vite env shape manually, and the built-in BASE_URL also needs to be filled in explicitly.
  // Otherwise, the mobile phone remote control cannot pass typecheck when distinguishing /remote and /remote/v3 based on the construction base.
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_DEV_ORIGIN?: string;
  readonly VITE_CONVERSATION_SHARE_PREVIEW_MOCK?: string;
  readonly VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
  // When OSS multi-version is released, the resource base has a version directory, and the page routing is explicitly given by this variable.
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly VITE_ZCODE_BASE_URL?: string;
  readonly VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  readonly VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
