export function formatFundingPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "-";
  }
  const pct = rate * 100;
  return `${pct.toFixed(4)}%`;
}

/** Как на биржах: знак «+» и больше знаков после запятой. */
export function formatFundingPercentSigned(
  rate: number | null | undefined,
  fractionDigits = 5,
): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "—";
  }
  const pct = rate * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(fractionDigits)}%`;
}

export function fundingCellClass(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return "text-muted-foreground";
  }
  if (rate === 0) return "text-foreground";
  if (rate > 0) return "text-emerald-700 dark:text-emerald-400";
  return "text-rose-700 dark:text-rose-400";
}
