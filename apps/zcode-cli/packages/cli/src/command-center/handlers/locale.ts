import type { UiLocale } from "@zcode/i18n";
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps } from "../types.js";

// English is the only language, so every requested tag — including a legacy
// "zh-CN" someone typed into an old config — coerces to this one value.
const ONLY_LOCALE: UiLocale = "en-US";
const ONLY_LOCALE_NOTE =
  "English (en-US) is the only supported language, so there is nothing to switch.";

export async function handleLocaleCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = (await readCurrentLocale(deps)) ?? ONLY_LOCALE;

  if (args.length === 0 || args === "status" || args === "list") {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: [`Current locale: ${current}.`, ONLY_LOCALE_NOTE].join("\n"),
    };
  }

  const setLocale = deps.setLocale ?? (await createAppLocaleSetter(deps));
  if (!setLocale) {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: "Locale switching is not available in this client.",
    };
  }

  try {
    const result = await setLocale(ONLY_LOCALE);
    return {
      locale: result.locale,
      mode: deps.getMode?.(),
      response: formatLocaleSetResult(args.trim(), result.locale, result.configPath),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: `Unable to set locale: ${message}`,
    };
  }
}

async function readCurrentLocale(deps: CommandCenterDeps) {
  const localLocale = deps.getLocale?.();
  if (localLocale) return localLocale;
  const app = await deps.getApp();
  return app.getLocale?.();
}

async function createAppLocaleSetter(
  deps: CommandCenterDeps,
): Promise<CommandCenterDeps["setLocale"]> {
  const app = await deps.getApp();
  return app.setLocale?.bind(app);
}

function formatLocaleSetResult(
  requested: string,
  locale: string,
  configPath: string | undefined,
): string {
  const effective =
    requested === locale
      ? `Locale is ${locale}.`
      : `${ONLY_LOCALE_NOTE} Effective locale is ${locale}.`;
  return configPath ? `${effective}\nConfig: ${configPath}` : effective;
}
