/**
 * Emits the authoritative `AppSettings` defaults for the Rust port.
 *
 * Read from the zod schema at runtime rather than transcribed by hand, so the
 * Rust `default_settings()` and the TypeScript `appSettingsSchema.parse({})`
 * cannot drift: re-run this after any schema change.
 *
 *   pnpm exec tsx scripts/gen-settings-defaults.ts > apps/zcode-tauri/src-tauri/tests/settings-defaults.json
 */
import { appSettingsSchema } from "../packages/shared/src/validationAppSettings.js";

const defaults = appSettingsSchema.parse({});
process.stdout.write(JSON.stringify(defaults, null, 2) + "\n");
