export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // The token value should still be localized and compact; Chinese displays ten thousand/billion, and English displays K/M/B.
  // In order to fix the English long unit of Start Plan, I mistakenly forced all locales to K/M/B.
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // The capacity badge of the model list is a technical specification and should not be changed to "ten thousand/billion" with the Chinese locale.
  return formatCompactTokenNumber("en-US", contextWindow);
}
