/**
 * The single resolution point for the Node dist download source (within this package).
 *
 * Same convention and same default as the `ZCODE_NODE_DIST_MIRROR` CI variable in
 * `.gitlab/ci/00-workflow.yml`, the `nodeDistBase()` in `scripts/prepare-prebuilds.mjs`,
 * and the `DEFAULT_MIRROR` in `scripts/cua-helper-sea-base.mjs`.
 * All four must stay in sync — the CI variable overrides
 * the code default, so once the two diverge, changing the code default is a no-op in CI.
 *
 * Both `stageCli.ts` and `scripts/prepare-prebuilds.mjs` hardcode
 * `https://nodejs.org/dist`, which the macOS CI runner cannot reach (`UND_ERR_CONNECT_TIMEOUT`, 10s).
 * The prepare-prebuilds and stage:remote-assets jobs
 * have both tripped over this; in practice they dodge it thanks to "a cache hit means no network access".
 *
 * Its own module rather than staying in stageCli.ts: the latter ends with a top-level `await main()`,
 * which executes on import and so cannot be referenced from tests.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
