import type { UiLocale, SupportedLocale } from "@zcode/contracts";
import { enUS } from "./locales/en-US.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { ZCodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, ZCodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, ZCodeCopy> = {
  "en-US": enUS,
};

export function getZCodeCopy(locale?: UiLocale | string, detected?: string | null): ZCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
