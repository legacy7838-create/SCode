import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import enUS from "./locales/en-US.js";

/** Simple intl utility: looks up a translation by id and supports {key} placeholder substitution */
export interface IntlInstance {
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
}

function createIntl(): IntlInstance {
  return {
    formatMessage({ id }, values) {
      let msg = enUS[id] ?? id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          msg = msg.replaceAll(`{${key}}`, String(val));
        }
      }
      return msg;
    },
  };
}

interface IntlContextValue {
  intl: IntlInstance;
  /**
   * The app now keeps English only, so the locale is a constant rather than switchable state. The
   * field is kept so that call sites which depend on locale formatting (Intl.NumberFormat, date and
   * token-count formatting) can keep stating explicitly which format they use, without scattering
   * the "en-US" literal across every call site.
   */
  locale: "en-US";
}

const IntlContext = createContext<IntlContextValue | null>(null);

/**
 * Internationalization provider — supplies the English intl instance.
 */
export function ZCodeIntlProvider({ children }: { children: ReactNode }) {
  const intl = useMemo(() => createIntl(), []);
  const value = useMemo<IntlContextValue>(() => ({ intl, locale: "en-US" }), [intl]);

  return <IntlContext value={value}>{children}</IntlContext>;
}

/** Gets the intl context */
export function useZCodeIntl(): IntlContextValue {
  const ctx = useContext(IntlContext);
  if (!ctx) {
    throw new Error("useZCodeIntl must be used within ZCodeIntlProvider");
  }
  return ctx;
}
