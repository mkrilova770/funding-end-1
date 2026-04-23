export type DataRow = { fundingTime: string; rateStr: string; r: number };

export type LayoutPoint = {
  fundingTime: string;
  rateStr: string;
  r: number;
  px: number;
  py: number;
  globalIdx: number;
};

export type HistoryPayload = {
  exchange: string;
  baseAsset: string;
  nativeSymbol: string;
  days: number;
  source: "db" | "live";
  supportsHistory: boolean;
  points: { fundingTime: string; rate: string }[];
};

export const CHART_LINE = "#22c55e";
export const CHART_LINE_B = "#3b82f6";
export const CHART_LINE_SPREAD = "#f59e0b";
export const CHART_DOT_FILL = "#22c55e";
export const CHART_DOT_FILL_B = "#3b82f6";
export const CHART_DOT_FILL_SPREAD = "#f59e0b";
export const CHART_DOT_STROKE = "var(--chart-dot-stroke, #ffffff)";
export const CHART_GRID = "var(--chart-grid, rgba(203, 213, 225, 0.5))";
export const CHART_ZERO = "var(--chart-zero, rgba(100, 116, 139, 0.7))";
export const CHART_TEXT = "var(--chart-text, #94a3b8)";
export const CHART_TEXT_ZERO = "var(--chart-text-zero, #64748b)";

export const VB = { w: 960, h: 340, left: 90, right: 40, top: 24, bottom: 44 };
export const PLOT_W = VB.w - VB.left - VB.right;
export const PLOT_H = VB.h - VB.top - VB.bottom;
export const MIN_WINDOW = 0.04;

export function toRateNumber(rate: string): number {
  const n = Number(rate);
  return Number.isFinite(n) ? n : NaN;
}

export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 0.0001;
  const exp = Math.floor(Math.log10(rough));
  const f = rough / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

export function formatYTickPct(v: number): string {
  const pct = v * 100;
  const abs = Math.abs(pct);
  const d = abs >= 1 ? 4 : abs >= 0.1 ? 5 : 6;
  return `${pct.toFixed(d)}%`;
}

export function prepareRows(
  points: { fundingTime: string; rate: string }[],
): DataRow[] {
  const asc = [...points].sort(
    (a, b) =>
      new Date(a.fundingTime).getTime() - new Date(b.fundingTime).getTime(),
  );
  return asc
    .map((p) => ({
      fundingTime: p.fundingTime,
      rateStr: p.rate,
      r: toRateNumber(p.rate),
    }))
    .filter((x) => Number.isFinite(x.r));
}

export function buildLayout(
  rows: DataRow[],
  startFrac: number,
  endFrac: number,
  yOverride?: { yLo: number; yHi: number },
) {
  if (rows.length < 2) return null;
  const n = rows.length;
  const i0 = Math.max(0, Math.floor(startFrac * (n - 1)) - 1);
  const i1 = Math.min(n - 1, Math.ceil(endFrac * (n - 1)) + 1);
  const slice = rows.slice(i0, i1 + 1);
  if (slice.length < 2) return null;

  const rs = slice.map((x) => x.r);
  const dMin = Math.min(...rs);
  const dMax = Math.max(...rs);

  let yLo: number;
  let yHi: number;

  if (yOverride) {
    yLo = yOverride.yLo;
    yHi = yOverride.yHi;
  } else {
    const pad = Math.max((dMax - dMin) * 0.1, 1e-8);
    yLo = dMin - pad;
    yHi = dMax + pad;
  }

  const span = yHi - yLo;
  const step = niceStep(span / 5);
  yLo = Math.floor(yLo / step) * step;
  yHi = Math.ceil(yHi / step) * step;
  if (yHi <= yLo) yHi = yLo + step;

  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi + step * 0.0001; v += step) {
    yTicks.push(v);
    if (yTicks.length > 16) break;
  }

  const yScale = (r: number) =>
    VB.top + (1 - (r - yLo) / (yHi - yLo)) * PLOT_H;

  const windowLen = endFrac - startFrac;
  const layoutPts: LayoutPoint[] = slice.map((row, si) => {
    const gi = i0 + si;
    const frac = n === 1 ? 0.5 : gi / (n - 1);
    const px = VB.left + ((frac - startFrac) / windowLen) * PLOT_W;
    const py = yScale(row.r);
    return {
      fundingTime: row.fundingTime,
      rateStr: row.rateStr,
      r: row.r,
      px,
      py,
      globalIdx: gi,
    };
  });

  const poly = layoutPts
    .map((p) => `${p.px.toFixed(2)},${p.py.toFixed(2)}`)
    .join(" ");
  const crossesZero = yLo <= 0 && yHi >= 0;
  const yZero = yScale(0);

  const visibleDays = windowLen * 60;
  let tickEvery: number;
  if (visibleDays <= 10) tickEvery = 1;
  else if (visibleDays <= 25) tickEvery = 2;
  else if (visibleDays <= 45) tickEvery = 5;
  else tickEvery = 7;

  const xTicks: { gi: number; label: string }[] = [];
  const seenDay = new Set<string>();
  let dayCounter = 0;
  for (let gi = i0; gi <= i1; gi++) {
    const t = new Date(rows[gi]!.fundingTime);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (!seenDay.has(key)) {
      seenDay.add(key);
      if (dayCounter % tickEvery === 0) {
        xTicks.push({
          gi,
          label: t.toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
          }),
        });
      }
      dayCounter++;
    }
  }

  return {
    layoutPts,
    poly,
    yTicks,
    xTicks,
    yLo,
    yHi,
    crossesZero,
    yZero,
    i0,
    startFrac,
    windowLen,
  };
}

export function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export type FundingSumEntry = { days: number; sum: number };

export function computeFundingSums(
  points: { fundingTime: string; rate: string }[],
): FundingSumEntry[] | null {
  if (!points.length) return null;
  const now = Date.now();
  const periods = [1, 3, 7, 14, 30, 60] as const;
  const cutoffs = periods.map((d) => now - d * 24 * 60 * 60 * 1000);
  const sums = periods.map(() => 0);
  for (const p of points) {
    const t = new Date(p.fundingTime).getTime();
    const r = toRateNumber(p.rate);
    if (!Number.isFinite(r)) continue;
    for (let i = 0; i < periods.length; i++) {
      if (t >= cutoffs[i]!) sums[i] += r;
    }
  }
  return periods.map((d, i) => ({ days: d, sum: sums[i]! }));
}

export function computeLatestRate(
  points: { fundingTime: string; rate: string }[],
): number | null {
  if (!points.length) return null;
  let bestT = -Infinity;
  let bestR: number | null = null;
  for (const p of points) {
    const t = new Date(p.fundingTime).getTime();
    const r = toRateNumber(p.rate);
    if (!Number.isFinite(r)) continue;
    if (t > bestT) {
      bestT = t;
      bestR = r;
    }
  }
  return bestR;
}
