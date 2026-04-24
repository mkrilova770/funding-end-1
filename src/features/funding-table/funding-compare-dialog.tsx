"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExchangeIcon } from "@/lib/exchanges/exchange-icon";
import { EXCHANGE_LABELS } from "@/lib/exchanges/labels";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import {
  formatFundingPercent,
  formatFundingPercentSigned,
  fundingCellClass,
} from "@/lib/formatters/funding";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DataRow,
  type HistoryPayload,
  type LayoutPoint,
  toRateNumber,
  niceStep,
  formatYTickPct,
  prepareRows,
  clientToSvg,
  clamp,
  computeFundingSums,
  computeLatestRate,
  VB,
  PLOT_W,
  PLOT_H,
  MIN_WINDOW,
  CHART_LINE,
  CHART_LINE_B,
  CHART_DOT_FILL,
  CHART_DOT_FILL_B,
  CHART_DOT_STROKE,
  CHART_GRID,
  CHART_ZERO,
  CHART_TEXT,
  CHART_TEXT_ZERO,
} from "@/features/funding-table/funding-chart-utils";

/* ------------------------------------------------------------------ */
/*  Dual-exchange layout builder                                      */
/* ------------------------------------------------------------------ */

function buildDualLayout(
  rowsA: DataRow[],
  rowsB: DataRow[],
  startFrac: number,
  endFrac: number,
) {
  const refRows = rowsA.length >= rowsB.length ? rowsA : rowsB;
  if (refRows.length < 2) return null;

  const n = refRows.length;
  const i0 = Math.max(0, Math.floor(startFrac * (n - 1)) - 1);
  const i1 = Math.min(n - 1, Math.ceil(endFrac * (n - 1)) + 1);

  function sliceAndLayout(rows: DataRow[]) {
    if (rows.length < 2) return { pts: [] as LayoutPoint[], poly: "" };
    const rn = rows.length;
    const ri0 = Math.max(0, Math.floor(startFrac * (rn - 1)) - 1);
    const ri1 = Math.min(rn - 1, Math.ceil(endFrac * (rn - 1)) + 1);
    const slice = rows.slice(ri0, ri1 + 1);
    return { slice, ri0, rn };
  }

  const sA = sliceAndLayout(rowsA);
  const sB = sliceAndLayout(rowsB);

  const allRates: number[] = [];
  if (sA.slice) for (const r of sA.slice) allRates.push(r.r);
  if (sB.slice) for (const r of sB.slice) allRates.push(r.r);
  if (allRates.length < 2) return null;

  const dMin = Math.min(...allRates);
  const dMax = Math.max(...allRates);
  const pad = Math.max((dMax - dMin) * 0.1, 1e-8);
  let yLo = dMin - pad;
  let yHi = dMax + pad;
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

  function layoutLine(rows: DataRow[], info: ReturnType<typeof sliceAndLayout>) {
    if (!info.slice || rows.length < 2) return { pts: [] as LayoutPoint[], poly: "" };
    const rn = info.rn!;
    const ri0 = info.ri0!;
    const pts: LayoutPoint[] = info.slice.map((row, si) => {
      const gi = ri0 + si;
      const frac = rn === 1 ? 0.5 : gi / (rn - 1);
      const px = VB.left + ((frac - startFrac) / windowLen) * PLOT_W;
      const py = yScale(row.r);
      return { fundingTime: row.fundingTime, rateStr: row.rateStr, r: row.r, px, py, globalIdx: gi };
    });
    const poly = pts.map((p) => `${p.px.toFixed(2)},${p.py.toFixed(2)}`).join(" ");
    return { pts, poly };
  }

  const lineA = layoutLine(rowsA, sA);
  const lineB = layoutLine(rowsB, sB);

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
    if (gi >= refRows.length) break;
    const t = new Date(refRows[gi]!.fundingTime);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (!seenDay.has(key)) {
      seenDay.add(key);
      if (dayCounter % tickEvery === 0) {
        xTicks.push({ gi, label: t.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }) });
      }
      dayCounter++;
    }
  }

  return {
    lineA,
    lineB,
    yTicks,
    xTicks,
    yLo,
    yHi,
    crossesZero,
    yZero,
    startFrac,
    windowLen,
    refRowsLen: refRows.length,
  };
}

/* ------------------------------------------------------------------ */
/*  Dual chart component                                              */
/* ------------------------------------------------------------------ */

function CompareChart({
  pointsA,
  pointsB,
  labelA,
  labelB,
  rangeDays,
}: {
  pointsA: { fundingTime: string; rate: string }[];
  pointsB: { fundingTime: string; rate: string }[];
  labelA: string;
  labelB: string;
  rangeDays: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });

  const rowsA = useMemo(() => prepareRows(pointsA), [pointsA]);
  const rowsB = useMemo(() => prepareRows(pointsB), [pointsB]);

  useEffect(() => {
    setViewStart(0);
    setViewEnd(1);
  }, [pointsA, pointsB]);

  const model = useMemo(
    () => buildDualLayout(rowsA, rowsB, viewStart, viewEnd),
    [rowsA, rowsB, viewStart, viewEnd],
  );

  const svgFracFromClient = useCallback(
    (clientX: number): number => {
      const svg = svgRef.current;
      if (!svg) return 0.5;
      const { x } = clientToSvg(svg, clientX, 0);
      return clamp((x - VB.left) / PLOT_W, 0, 1);
    },
    [],
  );

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const mouseF = svgFracFromClient(e.clientX);
      const dataFrac = viewStart + mouseF * (viewEnd - viewStart);
      let newLen = (viewEnd - viewStart) * factor;
      newLen = clamp(newLen, MIN_WINDOW, 1);
      let ns = dataFrac - mouseF * newLen;
      let ne = ns + newLen;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 1) { ns -= ne - 1; ne = 1; }
      setViewStart(clamp(ns, 0, 1));
      setViewEnd(clamp(ne, 0, 1));
    },
    [viewStart, viewEnd, svgFracFromClient],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { active: true, lastX: e.clientX };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const findNearest = useCallback(
    (pts: LayoutPoint[], targetPx: number) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i]!.px - targetPx);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return pts[best] ?? null;
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      setCursor({ x: e.clientX, y: e.clientY });

      if (dragRef.current.active) {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const pxPerFrac = rect.width > 0 ? (viewEnd - viewStart) / rect.width : 0;
        const dx = e.clientX - dragRef.current.lastX;
        dragRef.current.lastX = e.clientX;
        const shift = -dx * pxPerFrac;
        const windowLen = viewEnd - viewStart;
        let ns = viewStart + shift;
        let ne = ns + windowLen;
        if (ns < 0) { ne -= ns; ns = 0; }
        if (ne > 1) { ns -= ne - 1; ne = 1; }
        setViewStart(clamp(ns, 0, 1));
        setViewEnd(clamp(ne, 0, 1));
        setHoverPx(null);
      } else if (model) {
        const { x } = clientToSvg(svgRef.current!, e.clientX, e.clientY);
        setHoverPx(x);
      }
    },
    [model, viewStart, viewEnd],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  const resetZoom = useCallback(() => {
    setViewStart(0);
    setViewEnd(1);
  }, []);

  if (!model || (rowsA.length < 2 && rowsB.length < 2)) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-sm text-muted-foreground">
        Недостаточно точек для графика
      </div>
    );
  }

  const { lineA, lineB, yTicks, xTicks, yLo, yHi, crossesZero, yZero, startFrac, windowLen, refRowsLen } = model;
  const plotRight = VB.left + PLOT_W;
  const plotBottom = VB.top + PLOT_H;
  const isZoomed = viewStart > 0.001 || viewEnd < 0.999;

  const hovA = hoverPx !== null ? findNearest(lineA.pts, hoverPx) : null;
  const hovB = hoverPx !== null ? findNearest(lineB.pts, hoverPx) : null;
  const guidePx = hovA?.px ?? hovB?.px ?? null;

  const showDotsA = lineA.pts.length <= 120;
  const showDotsB = lineB.pts.length <= 120;

  const tooltipNode =
    (hovA || hovB) && !dragRef.current.active
      ? createPortal(
          <div
            className="pointer-events-none fixed z-[99999] w-max max-w-[300px] rounded-lg border border-border/80 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
            style={{ left: cursor.x + 6, top: cursor.y + 8 }}
          >
            {hovA && (
              <>
                <p className="font-medium text-foreground">
                  {new Date(hovA.fundingTime).toLocaleString("ru-RU", {
                    day: "2-digit",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-full" style={{ background: CHART_LINE }} />
                  <span className="text-muted-foreground">{labelA}:</span>
                  <span className={cn("font-semibold tabular-nums", fundingCellClass(hovA.r))}>
                    {formatFundingPercent(hovA.r)}
                  </span>
                </p>
              </>
            )}
            {hovB && (
              <p className={cn("flex items-center gap-1.5", hovA ? "mt-0.5" : "")}>
                <span className="inline-block size-2.5 rounded-full" style={{ background: CHART_LINE_B }} />
                <span className="text-muted-foreground">{labelB}:</span>
                <span className={cn("font-semibold tabular-nums", fundingCellClass(hovB.r))}>
                  {formatFundingPercent(hovB.r)}
                </span>
              </p>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <div className="flex items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full" style={{ background: CHART_LINE }} />
            <span className="font-medium">{labelA}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full" style={{ background: CHART_LINE_B }} />
            <span className="font-medium">{labelB}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isZoomed && (
            <button
              onClick={resetZoom}
              className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40 sm:text-sm"
            >
              Сбросить зум
            </button>
          )}
          <span className="shrink-0 rounded-md bg-foreground px-3.5 py-1.5 text-xs font-semibold text-background sm:text-sm">
            {rangeDays}Д
          </span>
        </div>
      </div>

      <div ref={wrapRef} className="relative select-none px-1 pb-3 sm:px-2 sm:pb-4">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB.w} ${VB.h}`}
          preserveAspectRatio="xMidYMid meet"
          className={cn("h-auto w-full touch-none", dragRef.current.active ? "cursor-grabbing" : isZoomed ? "cursor-grab" : "cursor-crosshair")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { onPointerUp(); setHoverPx(null); }}
          role="img"
          aria-label="Сравнительный график ставок финансирования"
        >
          <defs>
            <clipPath id="compare-clip">
              <rect x={VB.left} y={VB.top} width={PLOT_W} height={PLOT_H} />
            </clipPath>
          </defs>

          {yTicks.map((tick) => {
            const yy = VB.top + (1 - (tick - yLo) / (yHi - yLo)) * PLOT_H;
            return (
              <g key={tick}>
                <line x1={VB.left} x2={plotRight} y1={yy} y2={yy} stroke={CHART_GRID} strokeWidth={0.6} strokeDasharray="3 4" />
                <text x={VB.left - 8} y={yy + 4} textAnchor="end" fill={CHART_TEXT} fontSize={11} fontFamily="system-ui, sans-serif">
                  {formatYTickPct(tick)}
                </text>
              </g>
            );
          })}

          {crossesZero && yZero >= VB.top && yZero <= plotBottom ? (
            <g>
              <line x1={VB.left} x2={plotRight} y1={yZero} y2={yZero} stroke={CHART_ZERO} strokeWidth={0.8} strokeDasharray="5 4" />
              <text x={plotRight + 6} y={yZero + 4} textAnchor="start" fill={CHART_TEXT_ZERO} fontSize={11} fontFamily="system-ui, sans-serif">
                0%
              </text>
            </g>
          ) : null}

          <g clipPath="url(#compare-clip)">
            {guidePx !== null ? (
              <line x1={guidePx} x2={guidePx} y1={VB.top} y2={plotBottom} stroke="rgba(148,163,184,0.25)" strokeWidth={1} />
            ) : null}

            {lineA.poly && (
              <polyline fill="none" stroke={CHART_LINE} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" points={lineA.poly} />
            )}
            {lineB.poly && (
              <polyline fill="none" stroke={CHART_LINE_B} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" points={lineB.poly} />
            )}

            {showDotsA &&
              lineA.pts.map((p, i) => (
                <circle key={`a-${i}`} cx={p.px} cy={p.py} r={hovA === p ? 4.5 : 2.5} fill={CHART_DOT_FILL} stroke={CHART_DOT_STROKE} strokeWidth={1.2} />
              ))}
            {!showDotsA && hovA && (
              <circle cx={hovA.px} cy={hovA.py} r={4.5} fill={CHART_DOT_FILL} stroke={CHART_DOT_STROKE} strokeWidth={1.5} />
            )}

            {showDotsB &&
              lineB.pts.map((p, i) => (
                <circle key={`b-${i}`} cx={p.px} cy={p.py} r={hovB === p ? 4.5 : 2.5} fill={CHART_DOT_FILL_B} stroke={CHART_DOT_STROKE} strokeWidth={1.2} />
              ))}
            {!showDotsB && hovB && (
              <circle cx={hovB.px} cy={hovB.py} r={4.5} fill={CHART_DOT_FILL_B} stroke={CHART_DOT_STROKE} strokeWidth={1.5} />
            )}
          </g>

          {xTicks.map((xt, i) => {
            const frac = refRowsLen <= 1 ? 0.5 : xt.gi / (refRowsLen - 1);
            const px = VB.left + ((frac - startFrac) / windowLen) * PLOT_W;
            if (px < VB.left - 5 || px > plotRight + 5) return null;
            return (
              <text key={`${xt.label}-${i}`} x={px} y={VB.h - 8} textAnchor="middle" fill={CHART_TEXT} fontSize={11} fontFamily="system-ui, sans-serif">
                {xt.label}
              </text>
            );
          })}
        </svg>

        {isZoomed && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-muted/70 px-3 py-1 text-[10px] text-muted-foreground backdrop-blur sm:bottom-6">
            Скролл — зум · Перетащите — двигать
          </div>
        )}

        {tooltipNode}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sums block for one exchange                                       */
/* ------------------------------------------------------------------ */

function SumsRow({
  slug,
  points,
  color,
}: {
  slug: ExchangeAdapterSlug;
  points: { fundingTime: string; rate: string }[];
  color: string;
}) {
  const sums = useMemo(() => computeFundingSums(points), [points]);
  const latestRate = useMemo(() => computeLatestRate(points), [points]);
  const label = EXCHANGE_LABELS[slug];

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-full" style={{ background: color }} />
        <div className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border bg-background">
          <ExchangeIcon slug={slug} className="size-5" title={label} />
        </div>
        <span className="text-sm font-semibold">{label}</span>
        {latestRate !== null && (
          <span className={cn("ml-auto text-sm font-bold tabular-nums", fundingCellClass(latestRate))}>
            {formatFundingPercentSigned(latestRate, 5)}
          </span>
        )}
      </div>

      {sums && (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 sm:gap-2">
          {sums.map(({ days, sum }) => (
            <div key={days} className="flex flex-col items-center gap-0.5 rounded-lg bg-muted/40 px-2 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {days}Д
              </span>
              <span className={cn("text-xs font-bold tabular-nums sm:text-sm", fundingCellClass(sum))}>
                {formatFundingPercentSigned(sum, 4)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Arbitrage difference row (A − B)                                  */
/* ------------------------------------------------------------------ */

function DiffRow({
  sumsA,
  sumsB,
  labelA,
  labelB,
}: {
  sumsA: { days: number; sum: number }[] | null;
  sumsB: { days: number; sum: number }[] | null;
  labelA: string;
  labelB: string;
}) {
  const diffs = useMemo(() => {
    if (!sumsA || !sumsB) return null;
    return sumsA.map((a, i) => {
      const b = sumsB[i]!;
      return { days: a.days, diff: a.sum - b.sum };
    });
  }, [sumsA, sumsB]);

  if (!diffs) return null;

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-full bg-amber-500" />
        <span className="text-sm font-semibold">
          Разница ({labelA} − {labelB})
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          шорт / лонг арбитраж
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 sm:gap-2">
        {diffs.map(({ days, diff }) => (
          <div key={days} className="flex flex-col items-center gap-0.5 rounded-lg bg-amber-500/10 px-2 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {days}Д
            </span>
            <span
              className={cn(
                "text-xs font-bold tabular-nums sm:text-sm",
                fundingCellClass(diff),
              )}
            >
              {formatFundingPercentSigned(diff, 4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Events table for one exchange                                     */
/* ------------------------------------------------------------------ */

function EventsColumn({
  slug,
  points,
  color,
}: {
  slug: ExchangeAdapterSlug;
  points: { fundingTime: string; rate: string }[];
  color: string;
}) {
  const label = EXCHANGE_LABELS[slug];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label} ({points.length})
        </p>
      </div>
      <div className="max-h-[min(40vh,500px)] overflow-auto rounded-lg border border-border/70 bg-card">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 text-xs font-semibold">Время</TableHead>
              <TableHead className="h-9 text-right text-xs font-semibold">Ставка</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((row) => {
              const n = toRateNumber(row.rate);
              return (
                <TableRow key={row.fundingTime}>
                  <TableCell className="whitespace-nowrap py-1.5 text-xs text-muted-foreground tabular-nums">
                    {new Date(row.fundingTime).toLocaleString("ru-RU", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className={cn("py-1.5 text-right text-xs font-medium tabular-nums", fundingCellClass(n))}>
                    {formatFundingPercent(n)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exchange picker                                                   */
/* ------------------------------------------------------------------ */

function ExchangePicker({
  value,
  onChange,
  exclude,
  label,
}: {
  value: ExchangeAdapterSlug | null;
  onChange: (v: ExchangeAdapterSlug) => void;
  exclude: ExchangeAdapterSlug | null;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value as ExchangeAdapterSlug)}
        className="h-9 min-w-[140px] rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted/50 focus:ring-2 focus:ring-ring"
      >
        <option value="" disabled>
          Выберите биржу
        </option>
        {ALL_EXCHANGE_SLUGS.map((slug) => (
          <option key={slug} value={slug} disabled={slug === exclude}>
            {EXCHANGE_LABELS[slug]}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Spread types & hook                                               */
/* ------------------------------------------------------------------ */

type SpreadPayload = {
  base: string;
  exchangeA: string;
  exchangeB: string;
  days: number;
  currentSpread: {
    askA: number | null;
    bidA: number | null;
    askB: number | null;
    bidB: number | null;
    aToB: {
      entrySpread: number | null;
      exitSpread: number | null;
      netResult: number | null;
    };
    bToA: {
      entrySpread: number | null;
      exitSpread: number | null;
      netResult: number | null;
    };
  } | null;
  intervalMin: number;
  supportsKlinesA: boolean;
  supportsKlinesB: boolean;
  history: { time: number; spreadPct: number }[];
};

function useSpreadData(
  exchangeA: ExchangeAdapterSlug | null,
  exchangeB: ExchangeAdapterSlug | null,
  baseAsset: string | null,
  intervalMin: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["spread", exchangeA, exchangeB, baseAsset, intervalMin],
    enabled: enabled && Boolean(exchangeA && exchangeB && baseAsset),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("exchangeA", exchangeA!);
      params.set("exchangeB", exchangeB!);
      params.set("base", baseAsset!);
      params.set("interval", String(intervalMin));
      const res = await fetch(`/api/funding/spread?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Ошибка загрузки спреда");
      }
      return (await res.json()) as SpreadPayload;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: enabled ? 10_000 : false,
  });
}

/* ------------------------------------------------------------------ */
/*  Spread chart component                                            */
/* ------------------------------------------------------------------ */

type SpreadRow = { time: number; spreadPct: number };
type SpreadPt = SpreadRow & { px: number; py: number; globalIdx: number };

function buildSpreadLayout(
  rows: SpreadRow[],
  startFrac: number,
  endFrac: number,
) {
  if (rows.length < 2) return null;
  const n = rows.length;
  const i0 = Math.max(0, Math.floor(startFrac * (n - 1)) - 1);
  const i1 = Math.min(n - 1, Math.ceil(endFrac * (n - 1)) + 1);
  const slice = rows.slice(i0, i1 + 1);
  if (slice.length < 2) return null;

  const vals = slice.map((r) => r.spreadPct);
  const dMin = Math.min(...vals);
  const dMax = Math.max(...vals);
  const pad = Math.max((dMax - dMin) * 0.1, 0.001);
  let yLo = dMin - pad;
  let yHi = dMax + pad;
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

  const yScale = (v: number) =>
    VB.top + (1 - (v - yLo) / (yHi - yLo)) * PLOT_H;

  const windowLen = endFrac - startFrac;

  const pts: SpreadPt[] = slice.map((row, si) => {
    const gi = i0 + si;
    const frac = n === 1 ? 0.5 : gi / (n - 1);
    const px = VB.left + ((frac - startFrac) / windowLen) * PLOT_W;
    return { ...row, px, py: yScale(row.spreadPct), globalIdx: gi };
  });

  const poly = pts.map((p) => `${p.px.toFixed(2)},${p.py.toFixed(2)}`).join(" ");
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
    if (gi >= rows.length) break;
    const t = new Date(rows[gi]!.time);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (!seenDay.has(key)) {
      seenDay.add(key);
      if (dayCounter % tickEvery === 0) {
        xTicks.push({ gi, label: t.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }) });
      }
      dayCounter++;
    }
  }

  return { pts, poly, yTicks, xTicks, yLo, yHi, crossesZero, yZero, startFrac, windowLen, n };
}

const SPREAD_INTERVALS = [
  { value: 5, label: "5м" },
  { value: 30, label: "30м" },
  { value: 60, label: "1ч" },
  { value: 240, label: "4ч" },
] as const;

function SpreadChart({ data, labelA, labelB, interval, onIntervalChange, showReverse }: {
  data: SpreadPayload;
  labelA: string;
  labelB: string;
  interval: number;
  onIntervalChange: (v: number) => void;
  showReverse: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });

  const rows = useMemo(() => [...data.history].sort((a, b) => a.time - b.time), [data.history]);

  useEffect(() => { setViewStart(0); setViewEnd(1); }, [data.history]);

  const model = useMemo(
    () => buildSpreadLayout(rows, viewStart, viewEnd),
    [rows, viewStart, viewEnd],
  );

  const svgFracFromClient = useCallback(
    (clientX: number): number => {
      const svg = svgRef.current;
      if (!svg) return 0.5;
      const { x } = clientToSvg(svg, clientX, 0);
      return clamp((x - VB.left) / PLOT_W, 0, 1);
    },
    [],
  );

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const mouseF = svgFracFromClient(e.clientX);
      const dataFrac = viewStart + mouseF * (viewEnd - viewStart);
      let newLen = (viewEnd - viewStart) * factor;
      newLen = clamp(newLen, MIN_WINDOW, 1);
      let ns = dataFrac - mouseF * newLen;
      let ne = ns + newLen;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 1) { ns -= ne - 1; ne = 1; }
      setViewStart(clamp(ns, 0, 1));
      setViewEnd(clamp(ne, 0, 1));
    },
    [viewStart, viewEnd, svgFracFromClient],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { active: true, lastX: e.clientX };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      setCursor({ x: e.clientX, y: e.clientY });
      if (dragRef.current.active) {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const pxPerFrac = rect.width > 0 ? (viewEnd - viewStart) / rect.width : 0;
        const dx = e.clientX - dragRef.current.lastX;
        dragRef.current.lastX = e.clientX;
        const shift = -dx * pxPerFrac;
        const windowLen = viewEnd - viewStart;
        let ns = viewStart + shift;
        let ne = ns + windowLen;
        if (ns < 0) { ne -= ns; ns = 0; }
        if (ne > 1) { ns -= ne - 1; ne = 1; }
        setViewStart(clamp(ns, 0, 1));
        setViewEnd(clamp(ne, 0, 1));
        setHoverPx(null);
      } else if (model) {
        const { x } = clientToSvg(svgRef.current!, e.clientX, e.clientY);
        setHoverPx(x);
      }
    },
    [model, viewStart, viewEnd],
  );

  const onPointerUp = useCallback(() => { dragRef.current.active = false; }, []);
  const resetZoom = useCallback(() => { setViewStart(0); setViewEnd(1); }, []);

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`;
  const pctClass = (v: number) => v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const scenario = (entry: number, net: number) => {
    if (net > 0) return entry > 0 ? "ideal" : "convergence";
    return "loss";
  };
  const scenarioTone = (s: "ideal" | "convergence" | "loss") =>
    s === "ideal"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : s === "convergence"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-rose-500/30 bg-rose-500/5";
  const scenarioLabel = (s: "ideal" | "convergence" | "loss") =>
    s === "ideal"
      ? "🟢 Идеальный"
      : s === "convergence"
        ? "🟡 Допустимый"
        : "🔴 Плохой";

  function fmtPrice(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return "—";
    if (v === 0) return "$0";
    const abs = Math.abs(v);
    let digits: number;
    if (abs >= 1000) digits = 2;
    else if (abs >= 1) digits = 4;
    else if (abs >= 0.01) digits = 6;
    else digits = 8;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  }

  function avgSpread(days: number) {
    const cutoff = Date.now() - days * 86400_000;
    const f = rows.filter((r) => r.time >= cutoff);
    return f.length ? f.reduce((s, r) => s + r.spreadPct, 0) / f.length : null;
  }

  const cs = data.currentSpread;

  if (!data.supportsKlinesA || !data.supportsKlinesB) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
        Историческая цена недоступна для одной из выбранных бирж.
      </div>
    );
  }

  if (!model || rows.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-border/60 bg-card text-sm text-muted-foreground">
        Недостаточно данных для графика спреда
      </div>
    );
  }

  const { pts, poly, yTicks, xTicks, yLo, yHi, crossesZero, yZero, startFrac, windowLen, n: totalPts } = model;
  const plotRight = VB.left + PLOT_W;
  const plotBottom = VB.top + PLOT_H;
  const isZoomed = viewStart > 0.001 || viewEnd < 0.999;

  let hovPt: SpreadPt | null = null;
  if (hoverPx !== null && pts.length) {
    let best = pts[0]!;
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.px - hoverPx);
      if (d < bestD) { bestD = d; best = p; }
    }
    hovPt = best;
  }

  const showDots = pts.length <= 120;

  const tooltipNode =
    hovPt && !dragRef.current.active
      ? createPortal(
          <div
            className="pointer-events-none fixed z-[99999] w-max max-w-[280px] rounded-lg border border-border/80 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
            style={{ left: cursor.x + 6, top: cursor.y + 8 }}
          >
            <p className="font-medium text-foreground">
              {new Date(hovPt.time).toLocaleString("ru-RU", {
                day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit",
              })}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5">
              <span className="text-muted-foreground">Спред:</span>
              <span className={cn("font-semibold tabular-nums", pctClass(hovPt.spreadPct))}>
                {fmtPct(hovPt.spreadPct)}
              </span>
            </p>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="space-y-3">
      {/* Current bid/ask spreads — entry/exit/net by direction */}
      <div className={cn("grid grid-cols-1 gap-2", showReverse && "sm:grid-cols-2")}>
        {cs && cs.aToB.entrySpread != null && cs.aToB.exitSpread != null && cs.aToB.netResult != null && (() => {
          const sc = scenario(cs.aToB.entrySpread, cs.aToB.netResult);
          return (
          <div className={cn("space-y-2 rounded-xl border px-4 py-3 shadow-sm", scenarioTone(sc))}>
            <div className="flex items-center gap-2">
              <span className="inline-block size-3 shrink-0 rounded-full bg-emerald-500" />
              <span className="text-sm font-semibold">{labelA} → {labelB}</span>
              <span className={cn("ml-auto text-sm font-bold tabular-nums", pctClass(cs.aToB.netResult))}>
                {fmtPct(cs.aToB.netResult)}
              </span>
            </div>
            <div className="text-[11px] font-semibold text-muted-foreground">{scenarioLabel(sc)}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>Ask {labelA}: <span className="tabular-nums text-foreground">{fmtPrice(cs.askA)}</span></span>
              <span>Bid {labelB}: <span className="tabular-nums text-foreground">{fmtPrice(cs.bidB)}</span></span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Доход на входе</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.aToB.entrySpread))}>{fmtPct(cs.aToB.entrySpread)}</div>
              </div>
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Стоимость выхода</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.aToB.exitSpread))}>{fmtPct(cs.aToB.exitSpread)}</div>
              </div>
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Итог (Entry - Exit)</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.aToB.netResult))}>{fmtPct(cs.aToB.netResult)}</div>
              </div>
            </div>
          </div>
          );
        })()}
        {showReverse && cs && cs.bToA.entrySpread != null && cs.bToA.exitSpread != null && cs.bToA.netResult != null && (() => {
          const sc = scenario(cs.bToA.entrySpread, cs.bToA.netResult);
          return (
          <div className={cn("space-y-2 rounded-xl border px-4 py-3 shadow-sm", scenarioTone(sc))}>
            <div className="flex items-center gap-2">
              <span className="inline-block size-3 shrink-0 rounded-full bg-blue-500" />
              <span className="text-sm font-semibold">{labelB} → {labelA}</span>
              <span className={cn("ml-auto text-sm font-bold tabular-nums", pctClass(cs.bToA.netResult))}>
                {fmtPct(cs.bToA.netResult)}
              </span>
            </div>
            <div className="text-[11px] font-semibold text-muted-foreground">{scenarioLabel(sc)}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>Ask {labelB}: <span className="tabular-nums text-foreground">{fmtPrice(cs.askB)}</span></span>
              <span>Bid {labelA}: <span className="tabular-nums text-foreground">{fmtPrice(cs.bidA)}</span></span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Доход на входе</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.bToA.entrySpread))}>{fmtPct(cs.bToA.entrySpread)}</div>
              </div>
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Стоимость выхода</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.bToA.exitSpread))}>{fmtPct(cs.bToA.exitSpread)}</div>
              </div>
              <div className="rounded-md bg-background/60 px-2 py-1">
                <span className="text-muted-foreground">Итог (Entry - Exit)</span>
                <div className={cn("font-semibold tabular-nums", pctClass(cs.bToA.netResult))}>{fmtPct(cs.bToA.netResult)}</div>
              </div>
            </div>
          </div>
          );
        })()}
      </div>

      {/* Average historical spread (single line, close-price based) */}
      <div className="grid grid-cols-3 gap-2">
        {([7, 30, 60] as const).map((d) => {
          const avg = avgSpread(d);
          return (
            <div key={d} className="flex flex-col items-center gap-0.5 rounded-lg border border-border/40 bg-muted/30 px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Сред. {d}Д</span>
              {avg !== null && (
                <span className={cn("text-sm font-bold tabular-nums", pctClass(avg))}>
                  {fmtPct(avg)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Single-line chart: directional entry-like spread for selected side A -> B */}
      <div className="shrink-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 sm:px-6 sm:py-5">
          <span className="text-sm font-medium">
            Спред входа (по close): {labelA} → {labelB}
          </span>
          <div className="flex items-center gap-1.5">
            {SPREAD_INTERVALS.map((iv) => (
              <button
                key={iv.value}
                onClick={() => onIntervalChange(iv.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors sm:px-3 sm:py-1.5 sm:text-sm",
                  iv.value === interval
                    ? "bg-foreground text-background"
                    : "border border-border/80 bg-background text-foreground/60 hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {iv.label}
              </button>
            ))}
            {isZoomed && (
              <button
                onClick={resetZoom}
                className="ml-1 rounded-md border border-border/80 bg-background px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40 sm:px-3 sm:py-1.5 sm:text-sm"
              >
                Сбросить зум
              </button>
            )}
          </div>
        </div>

        <div ref={wrapRef} className="relative select-none px-1 pb-3 sm:px-2 sm:pb-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB.w} ${VB.h}`}
            preserveAspectRatio="xMidYMid meet"
            className={cn("h-auto w-full touch-none", dragRef.current.active ? "cursor-grabbing" : isZoomed ? "cursor-grab" : "cursor-crosshair")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { onPointerUp(); setHoverPx(null); }}
            role="img"
            aria-label="График ценового спреда"
          >
            <defs>
              <clipPath id="spread-clip">
                <rect x={VB.left} y={VB.top} width={PLOT_W} height={PLOT_H} />
              </clipPath>
            </defs>

            {yTicks.map((tick) => {
              const yy = VB.top + (1 - (tick - yLo) / (yHi - yLo)) * PLOT_H;
              return (
                <g key={tick}>
                  <line x1={VB.left} x2={plotRight} y1={yy} y2={yy} stroke={CHART_GRID} strokeWidth={0.6} strokeDasharray="3 4" />
                  <text x={VB.left - 8} y={yy + 4} textAnchor="end" fill={CHART_TEXT} fontSize={11} fontFamily="system-ui, sans-serif">
                    {tick.toFixed(4)}%
                  </text>
                </g>
              );
            })}

            {crossesZero && yZero >= VB.top && yZero <= plotBottom ? (
              <g>
                <line x1={VB.left} x2={plotRight} y1={yZero} y2={yZero} stroke={CHART_ZERO} strokeWidth={0.8} strokeDasharray="5 4" />
                <text x={plotRight + 6} y={yZero + 4} textAnchor="start" fill={CHART_TEXT_ZERO} fontSize={11} fontFamily="system-ui, sans-serif">
                  0%
                </text>
              </g>
            ) : null}

            <g clipPath="url(#spread-clip)">
              {hovPt && (
                <line x1={hovPt.px} x2={hovPt.px} y1={VB.top} y2={plotBottom} stroke="rgba(148,163,184,0.25)" strokeWidth={1} />
              )}

              <polyline fill="none" stroke={CHART_LINE} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" points={poly} />

              {showDots && pts.map((p, i) => (
                <circle key={i} cx={p.px} cy={p.py} r={hovPt === p ? 4.5 : 2.5} fill={CHART_DOT_FILL} stroke={CHART_DOT_STROKE} strokeWidth={1.2} />
              ))}
              {!showDots && hovPt && (
                <circle cx={hovPt.px} cy={hovPt.py} r={4.5} fill={CHART_DOT_FILL} stroke={CHART_DOT_STROKE} strokeWidth={1.5} />
              )}
            </g>

            {xTicks.map((xt, i) => {
              const frac = totalPts <= 1 ? 0.5 : xt.gi / (totalPts - 1);
              const px = VB.left + ((frac - startFrac) / windowLen) * PLOT_W;
              if (px < VB.left - 5 || px > plotRight + 5) return null;
              return (
                <text key={`${xt.label}-${i}`} x={px} y={VB.h - 8} textAnchor="middle" fill={CHART_TEXT} fontSize={11} fontFamily="system-ui, sans-serif">
                  {xt.label}
                </text>
              );
            })}
          </svg>

          {isZoomed && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-muted/70 px-3 py-1 text-[10px] text-muted-foreground backdrop-blur sm:bottom-6">
              Скролл — зум · Перетащите — двигать
            </div>
          )}
          {tooltipNode}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main compare dialog                                               */
/* ------------------------------------------------------------------ */

function useFundingHistory(
  exchange: ExchangeAdapterSlug | null,
  baseAsset: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["funding-history", exchange, baseAsset, 60],
    enabled: enabled && Boolean(exchange && baseAsset),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("exchange", exchange!);
      params.set("base", baseAsset!);
      params.set("days", "60");
      const res = await fetch(`/api/funding/history?${params.toString()}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Ошибка загрузки");
      }
      return (await res.json()) as HistoryPayload;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function FundingCompareDialog({
  open,
  onOpenChange,
  baseAsset,
  initialExchangeA = null,
  initialExchangeB = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseAsset: string | null;
  initialExchangeA?: ExchangeAdapterSlug | null;
  initialExchangeB?: ExchangeAdapterSlug | null;
}) {
  const [exchangeA, setExchangeA] = useState<ExchangeAdapterSlug | null>(null);
  const [exchangeB, setExchangeB] = useState<ExchangeAdapterSlug | null>(null);
  const [spreadInterval, setSpreadInterval] = useState<number>(240);
  const [showReverseSpread, setShowReverseSpread] = useState(true);

  useEffect(() => {
    if (open) {
      setExchangeA(initialExchangeA);
      setExchangeB(initialExchangeB);
      setShowReverseSpread(true);
    }
  }, [open, initialExchangeA, initialExchangeB]);

  const bothSelected = Boolean(exchangeA && exchangeB);
  const queryA = useFundingHistory(exchangeA, baseAsset, open && bothSelected);
  const queryB = useFundingHistory(exchangeB, baseAsset, open && bothSelected);
  const spreadQuery = useSpreadData(exchangeA, exchangeB, baseAsset, spreadInterval, open && bothSelected);

  const isLoading = queryA.isLoading || queryB.isLoading;
  const isError = queryA.isError || queryB.isError;
  const errorMsg = queryA.error
    ? (queryA.error as Error).message
    : queryB.error
      ? (queryB.error as Error).message
      : "";

  const hasDataA = Boolean(queryA.data?.points.length);
  const hasDataB = Boolean(queryB.data?.points.length);
  const hasAnyData = hasDataA || hasDataB;

  const labelA = exchangeA ? EXCHANGE_LABELS[exchangeA] : "";
  const labelB = exchangeB ? EXCHANGE_LABELS[exchangeB] : "";

  const sumsA = useMemo(
    () => (queryA.data ? computeFundingSums(queryA.data.points) : null),
    [queryA.data],
  );
  const sumsB = useMemo(
    () => (queryB.data ? computeFundingSums(queryB.data.points) : null),
    [queryB.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[96vh] w-[min(98vw,90rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]"
      >
        <div className="shrink-0 border-b bg-muted/25 px-6 py-4 sm:px-8 sm:py-5">
          <DialogHeader className="gap-2 text-left">
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-xl sm:text-2xl">
                Сравнение фандинга
              </DialogTitle>
              <DialogDescription className="text-left text-base text-foreground sm:text-lg">
                {baseAsset ?? "—"}
              </DialogDescription>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <ExchangePicker
                value={exchangeA}
                onChange={setExchangeA}
                exclude={exchangeB}
                label="Биржа A:"
              />
              <ExchangePicker
                value={exchangeB}
                onChange={setExchangeB}
                exclude={exchangeA}
                label="Биржа B:"
              />
            </div>
          </DialogHeader>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 sm:gap-8 sm:px-8 sm:py-6">
          {!bothSelected ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              <span className="text-sm">Выберите обе биржи для сравнения</span>
            </div>
          ) : isLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              <div className="size-10 animate-pulse rounded-full bg-muted" />
              <span className="text-sm">Загрузка истории…</span>
            </div>
          ) : isError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm text-destructive">
              {errorMsg}
            </div>
          ) : !hasAnyData ? (
            <p className="rounded-xl border bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
              За выбранный период событий фандинга нет ни на одной из бирж.
            </p>
          ) : (
            <>
              {/* Sums blocks + difference */}
              <div className="flex flex-col gap-3">
                {exchangeA && queryA.data && (
                  <SumsRow slug={exchangeA} points={queryA.data.points} color={CHART_LINE} />
                )}
                {exchangeB && queryB.data && (
                  <SumsRow slug={exchangeB} points={queryB.data.points} color={CHART_LINE_B} />
                )}
                <DiffRow
                  sumsA={sumsA}
                  sumsB={sumsB}
                  labelA={labelA}
                  labelB={labelB}
                />
              </div>

              {/* Price spread section */}
              {spreadQuery.data && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">
                      Ценовой спред (вход / выход)
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowReverseSpread((v) => !v)}
                        className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40"
                      >
                        {showReverseSpread ? "Скрыть 2-ю колонку" : "Показать 2-ю колонку"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void spreadQuery.refetch();
                        }}
                        disabled={spreadQuery.isFetching}
                        className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {spreadQuery.isFetching ? "Обновление..." : "Обновить Bid/Ask"}
                      </button>
                    </div>
                  </div>
                  <SpreadChart
                    data={spreadQuery.data}
                    labelA={labelA}
                    labelB={labelB}
                    interval={spreadInterval}
                    onIntervalChange={setSpreadInterval}
                    showReverse={showReverseSpread}
                  />
                </div>
              )}
              {spreadQuery.isLoading && bothSelected && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <div className="size-4 animate-pulse rounded-full bg-amber-500/30" />
                  Загрузка спреда цен…
                </div>
              )}
              {spreadQuery.isError && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
                  Не удалось загрузить спред: {(spreadQuery.error as Error)?.message}
                </div>
              )}

              {/* Dual chart */}
              <CompareChart
                pointsA={queryA.data?.points ?? []}
                pointsB={queryB.data?.points ?? []}
                labelA={labelA}
                labelB={labelB}
                rangeDays={60}
              />

              {/* Side-by-side events */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {exchangeA && queryA.data && (
                  <EventsColumn slug={exchangeA} points={queryA.data.points} color={CHART_LINE} />
                )}
                {exchangeB && queryB.data && (
                  <EventsColumn slug={exchangeB} points={queryB.data.points} color={CHART_LINE_B} />
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
