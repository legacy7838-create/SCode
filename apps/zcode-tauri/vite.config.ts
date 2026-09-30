import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../../packages/ui/vite/pdfJsCMapsPlugin.js";
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

/**
 * The Tauri renderer now mounts the real `@zcode/ui` `<Root>`, so this config
 * mirrors `packages/web/vite.config.ts`: it feeds the shared UI the same `@`
 * alias, the same endpoint `define`s, and the same `/ws` + `/api` proxy to the
 * local `@zcode/server`. Only the dev-server shape (fixed :5199, `clearScreen`,
 * env prefix, `src-tauri` watch ignore) is Tauri-specific — Tauri drives Vite
 * through `devUrl` in `src-tauri/tauri.conf.json`.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);
  // Where the local business-service server listens; mirrors the web proxy default.
  const serverPort = Number(env.PORT) || 3030;

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss()],
    clearScreen: false,
    resolve: {
      alias: {
        // The shared UI source imports `@/...`; the consuming build must map it.
        "@": resolve(HERE, "../../packages/ui/src"),
        // Pin d3-path to the 3.x entry recharts/d3-shape expects (see web config).
        "d3-path": resolve(REPO_ROOT, "node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5199,
      strictPort: true,
      host: "127.0.0.1",
      proxy: {
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
        "/api": { target: `http://localhost:${serverPort}` },
      },
      watch: {
        // The Rust side has its own watcher; watching it here would restart the
        // frontend on every backend rebuild.
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_"],
    optimizeDeps: {
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        treeshake: false,
      },
    },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: false,
    },
  };
});
