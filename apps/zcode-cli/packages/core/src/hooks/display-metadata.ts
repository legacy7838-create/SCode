const SENSITIVE_KEY =
  "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
const SENSITIVE_IDENTIFIER = `(?:[A-Za-z0-9]+[_-])*${SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*`;
const MASK = "••••";

export function sanitizeHookDisplayText(value: string): string {
  if (!value) return value;
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}:${MASK}@`)
    .replace(
      /(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu,
      `$1${MASK}`,
    )
    .replace(
      new RegExp(`([?&](?:authorization|${SENSITIVE_IDENTIFIER})=)[^&\\s"']+`, "giu"),
      `$1${MASK}`,
    )
    .replace(/(\bauthorization\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)/giu, `$1${MASK}`)
    .replace(
      new RegExp(
        `((?:"${SENSITIVE_IDENTIFIER}"|'${SENSITIVE_IDENTIFIER}')\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "giu",
      ),
      `$1${MASK}`,
    )
    .replace(
      new RegExp(
        `(^|[^A-Za-z0-9_])(${SENSITIVE_IDENTIFIER}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`,
        "gimu",
      ),
      `$1$2${MASK}`,
    )
    .replace(
      new RegExp(`((?:--)?${SENSITIVE_IDENTIFIER})(\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "giu"),
      `$1$2${MASK}`,
    );
}
