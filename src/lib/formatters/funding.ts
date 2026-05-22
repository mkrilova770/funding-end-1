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

/** MEXC и др.: кроме 1/2/4/8 встречается суточный цикл. */
const STANDARD_FUNDING_INTERVAL_HOURS = [1, 2, 4, 8, 24] as const;

/** Приводит сырое значение часов к стандартному шагу (допуск ±0.5 ч на шум API). */
export function normalizeStandardFundingIntervalHours(
  hoursApprox: number | null | undefined,
): (typeof STANDARD_FUNDING_INTERVAL_HOURS)[number] | null {
  if (
    hoursApprox === null ||
    hoursApprox === undefined ||
    !Number.isFinite(hoursApprox)
  ) {
    return null;
  }
  if (hoursApprox <= 0 || hoursApprox > 48) return null;
  let best: (typeof STANDARD_FUNDING_INTERVAL_HOURS)[number] | null = null;
  let bestDist = Infinity;
  for (const h of STANDARD_FUNDING_INTERVAL_HOURS) {
    const d = Math.abs(hoursApprox - h);
    if (d < bestDist - 1e-9) {
      bestDist = d;
      best = h;
    }
  }
  if (best === null || bestDist > 0.52) return null;
  return best;
}

/** Подпись «8ч» для ячейки таблицы; пустая строка если интервал неизвестен. */
export function formatFundingIntervalShortLabel(
  hours: number | null | undefined,
): string {
  const h = normalizeStandardFundingIntervalHours(hours);
  return h === null ? "" : `${h}ч`;
}
