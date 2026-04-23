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
  type HistoryPayload,
  toRateNumber,
  formatYTickPct,
  prepareRows,
  buildLayout,
  clientToSvg,
  clamp,
  computeFundingSums,
  computeLatestRate,
  VB,
  PLOT_W,
  PLOT_H,
  MIN_WINDOW,
  CHART_LINE,
  CHART_DOT_FILL,
  CHART_DOT_STROKE,
  CHART_GRID,
  CHART_ZERO,
  CHART_TEXT,
  CHART_TEXT_ZERO,
} from "@/features/funding-table/funding-chart-utils";

function FundingReferenceChart({
  points,
  latestRate,
  rangeDays,
}: {
  points: { fundingTime: string; rate: string }[];
  latestRate: number | null;
  rangeDays: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const dragRef = useRef<{ active: boolean; lastX: number }>({ active: false, lastX: 0 });

  const allRows = useMemo(() => prepareRows(points), [points]);

  useEffect(() => {
    setViewStart(0);
    setViewEnd(1);
  }, [points]);

  const model = useMemo(
    () => buildLayout(allRows, viewStart, viewEnd),
    [allRows, viewStart, viewEnd],
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
      ns = clamp(ns, 0, 1);
      ne = clamp(ne, 0, 1);
      setViewStart(ns);
      setViewEnd(ne);
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
        setHoverIdx(null);
      } else if (model) {
        const { x } = clientToSvg(svgRef.current!, e.clientX, e.clientY);
        const relX = x - VB.left;
        const frac = clamp(relX / PLOT_W, 0, 1);
        const pts = model.layoutPts;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const d = Math.abs(pts[i]!.px - (VB.left + frac * PLOT_W));
          if (d < bestDist) { bestDist = d; best = i; }
        }
        setHoverIdx(best);
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

  if (!model || allRows.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-sm text-muted-foreground">
        Недостаточно точек для графика
      </div>
    );
  }

  const { layoutPts, poly, yTicks, xTicks, yLo, yHi, crossesZero, yZero, startFrac, windowLen } = model;
  const plotRight = VB.left + PLOT_W;
  const plotBottom = VB.top + PLOT_H;
  const hov = hoverIdx !== null ? layoutPts[hoverIdx] ?? null : null;
  const isZoomed = viewStart > 0.001 || viewEnd < 0.999;

  const showDots = layoutPts.length <= 120;

  const tooltipNode =
    hov && !dragRef.current.active
      ? createPortal(
          <div
            className="pointer-events-none fixed z-[99999] w-max max-w-[260px] rounded-lg border border-border/80 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
            style={{ left: cursor.x + 6, top: cursor.y + 8 }}
          >
            <p className="font-medium text-foreground">
              {new Date(hov.fundingTime).toLocaleString("ru-RU", {
                day: "2-digit",
                month: "long",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            <p className={cn("mt-1 font-semibold tabular-nums", fundingCellClass(hov.r))}>
              {formatFundingPercent(hov.r)}
            </p>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <div className="flex items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
        <p className="text-sm font-medium text-foreground sm:text-base">
          Ставка финансирования:{" "}
          <span
            className={cn(
              "font-bold tabular-nums",
              latestRate === null ? "text-muted-foreground" : fundingCellClass(latestRate),
            )}
          >
            {latestRate === null ? "—" : formatFundingPercentSigned(latestRate, 5)}
          </span>
        </p>
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
            Последние {rangeDays}Д
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
          onPointerLeave={() => { onPointerUp(); setHoverIdx(null); }}
          role="img"
          aria-label="График ставки финансирования"
        >
          <defs>
            <clipPath id="plot-clip">
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

          <g clipPath="url(#plot-clip)">
            {hov ? (
              <line x1={hov.px} x2={hov.px} y1={VB.top} y2={plotBottom} stroke="rgba(34,197,94,0.18)" strokeWidth={1} />
            ) : null}

            <polyline fill="none" stroke={CHART_LINE} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" points={poly} />

            {showDots &&
              layoutPts.map((p, i) => (
                <circle
                  key={`${p.fundingTime}-${i}`}
                  cx={p.px}
                  cy={p.py}
                  r={hoverIdx === i ? 4.5 : 3}
                  fill={CHART_DOT_FILL}
                  stroke={CHART_DOT_STROKE}
                  strokeWidth={1.5}
                />
              ))}

            {!showDots && hov ? (
              <circle cx={hov.px} cy={hov.py} r={4.5} fill={CHART_DOT_FILL} stroke={CHART_DOT_STROKE} strokeWidth={1.5} />
            ) : null}
          </g>

          {xTicks.map((xt, i) => {
            const gi = xt.gi;
            const frac = allRows.length <= 1 ? 0.5 : gi / (allRows.length - 1);
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

export function FundingHistoryDialog({
  open,
  onOpenChange,
  exchange,
  baseAsset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchange: ExchangeAdapterSlug | null;
  baseAsset: string | null;
}) {
  const rangeDays = 60;

  const query = useQuery({
    queryKey: ["funding-history", exchange, baseAsset, rangeDays],
    enabled: open && Boolean(exchange && baseAsset),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("exchange", exchange!);
      params.set("base", baseAsset!);
      params.set("days", String(rangeDays));
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

  const latestRate = useMemo(
    () => (query.data ? computeLatestRate(query.data.points) : null),
    [query.data],
  );

  const fundingSums = useMemo(
    () => (query.data ? computeFundingSums(query.data.points) : null),
    [query.data],
  );

  const titleExchange =
    exchange && EXCHANGE_LABELS[exchange] ? EXCHANGE_LABELS[exchange] : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[96vh] w-[min(98vw,90rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]"
      >
        <div className="shrink-0 border-b bg-muted/25 px-6 py-4 sm:px-8 sm:py-5">
          <DialogHeader className="gap-2 text-left">
            <div className="flex flex-wrap items-start gap-4">
              {exchange ? (
                <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border bg-background shadow-sm sm:size-14">
                  <ExchangeIcon slug={exchange} className="size-10 sm:size-11" title={titleExchange} />
                </div>
              ) : null}
              <div className="min-w-0 flex-1 space-y-1">
                <DialogTitle className="text-xl sm:text-2xl">
                  История фандинга
                </DialogTitle>
                <DialogDescription className="text-left text-base text-foreground sm:text-lg">
                  {baseAsset ?? "—"} · {titleExchange}
                </DialogDescription>
                {query.data ? (
                  <p className="text-sm text-muted-foreground">
                    Контракт{" "}
                    <span className="font-mono text-foreground/90">
                      {query.data.nativeSymbol}
                    </span>
                    {query.data.source === "db" ? " · из базы" : " · с биржи"}
                  </p>
                ) : null}
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 sm:gap-8 sm:px-8 sm:py-6">
          {query.isLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
              <div className="size-10 animate-pulse rounded-full bg-muted" />
              <span className="text-sm">Загрузка истории…</span>
            </div>
          ) : query.isError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm text-destructive">
              {(query.error as Error).message}
            </div>
          ) : query.data ? (
            <>
              {query.data.supportsHistory === false ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-50 px-6 py-12 text-center dark:bg-amber-950/20">
                  <span className="text-3xl">⚠️</span>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {EXCHANGE_LABELS[query.data.exchange as ExchangeAdapterSlug] ?? query.data.exchange} не предоставляет публичный API для истории фандинга.
                  </p>
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/70">
                    Текущая ставка фандинга доступна в основной таблице. История появится, когда сервис синхронизации начнёт сохранять данные в базу.
                  </p>
                </div>
              ) : query.data.points.length === 0 ? (
                <p className="rounded-xl border bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
                  За выбранный период событий фандинга нет.
                </p>
              ) : (
                <>
                  <FundingReferenceChart
                    points={query.data.points}
                    latestRate={latestRate}
                    rangeDays={rangeDays}
                  />

                  {fundingSums && (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 sm:gap-3">
                      {fundingSums.map(({ days, sum }) => (
                        <div
                          key={days}
                          className="flex flex-col items-center gap-1 rounded-xl border border-border/60 bg-card px-3 py-3 shadow-sm"
                        >
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {days}Д
                          </span>
                          <span
                            className={cn(
                              "text-sm font-bold tabular-nums sm:text-base",
                              fundingCellClass(sum),
                            )}
                          >
                            {formatFundingPercentSigned(sum, 4)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex shrink-0 flex-col gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      События ({query.data.points.length})
                    </p>
                    <div className="max-h-[min(40vh,500px)] overflow-auto rounded-lg border border-border/70 bg-card">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-11 w-[46%] text-xs font-semibold sm:text-sm">
                              Время
                            </TableHead>
                            <TableHead className="h-11 text-right text-xs font-semibold sm:text-sm">
                              Ставка
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {query.data.points.map((row, idx) => {
                            const n = toRateNumber(row.rate);
                            return (
                              <TableRow key={`${row.fundingTime}-${idx}`}>
                                <TableCell className="whitespace-nowrap py-2.5 text-sm text-muted-foreground tabular-nums sm:py-3 sm:text-base">
                                  {new Date(row.fundingTime).toLocaleString("ru-RU", {
                                    day: "2-digit",
                                    month: "short",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </TableCell>
                                <TableCell
                                  className={cn(
                                    "py-2.5 text-right text-sm font-medium tabular-nums sm:py-3 sm:text-base",
                                    fundingCellClass(n),
                                  )}
                                >
                                  {formatFundingPercent(n)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
