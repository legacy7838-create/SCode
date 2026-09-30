import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
// Vite configuration is executed during Node loading, and the @zcode/shared root entry cannot be imported.
// The root entry contains NodeNext style source code re-export, Node will look for .js as real files and fail in the bootstrap phase.
import {
  resolveRuntimeZCodeEndpointOrigin,
  pickProductEndpointEnv,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` only provide link constants; the current production environment is injected with ZCODE_ENV by the startup script or CI.
  // The startup script explicitly selects test/production via process.env; it must take precedence over the .env file,
  // Otherwise share:test may be misresolved to the wrong endpoint by the old configuration of mode.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // ZAI OAuth client_id is a public identifier that allows injection of browser packages; secret/token is not allowed to go through VITE_.
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: {
        // Fix @ alias resolution failure in UI component library.
        // Cause of the problem: The source code of packages/ui is directly handed over to Vite for packaging by the web application, but the web itself does not declare @ -> packages/ui/src.
        // So imports like "@/components/lib/utils" will report that the module cannot be found during the runtime build phase.
        // Here, the alias is added to the consumer Vite configuration, keeping the source code of the existing components unchanged and minimizing the impact.
        "@": resolve(__dirname, "../ui/src"),
        // Recharts depends on d3-shape@3.x, which requires the Path export of d3-path.
        // hoisted node_modules may expose the old d3-path@1.x next to d3-shape to Vite pre-builds,
        // Causes desktop/web dev to fail in dependency optimization phase; explicitly points to root 3.x entry to fix parsing boundaries.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // When debugging web login locally, the OAuth token exchange must first hit the online same-origin interface.
        // This dedicated proxy is placed before the `/api` wildcard proxy to avoid being forwarded to the local server and causing 404.
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Proxy /ws and /api requests to server (default port 3030)
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // Fix: Explicitly add react-related entries in the dependency pre-building phase to avoid rolldown parsing `react/jsx-runtime`
      // / `react/jsx-dev-runtime` returns a loading failure (UNLOADABLE_DEPENDENCY) caused by an unsuffixed path.
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // The worker entry of @pierre/diffs relies on importing and then registering the message listener.
        // Its missing package sideEffects declaration will cause the production worker sub-build to be shaken to 0B;
        // Only turn off tree shaking built by workers to avoid affecting the main package.
        treeshake: false,
      },
    },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Compatible with old Web runtime reading names; new codes uniformly read VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // Explicitly inject OAuth public configuration to avoid the web end from implicitly relying on source code fallback in different modes.
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // Production does not expose the sourceMappingURL in browser products to prevent the client from restoring the business source code.
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
