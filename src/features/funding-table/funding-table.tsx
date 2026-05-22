"use client";

import { ChevronDown, ChevronUp, Star, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FundingHistoryDialog } from "@/features/funding-table/funding-history-dialog";
import { FundingCompareDialog } from "@/features/funding-table/funding-compare-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExchangeIcon } from "@/lib/exchanges/exchange-icon";
import { EXCHANGE_LABELS } from "@/lib/exchanges/labels";
import {
  fundingCellClass,
  formatFundingPercent,
  formatFundingIntervalShortLabel,
} from "@/lib/formatters/funding";
import type { FundingTableRow } from "@/lib/services/funding-table";
import type { ColumnId } from "@/features/funding-table/funding-ui-store";
import { columnTitle, useFundingUiStore } from "@/features/funding-table/funding-ui-store";
import { cn } from "@/lib/utils";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";

function ExchangeBadge({ slug }: { slug: ExchangeAdapterSlug }) {
  const label = EXCHANGE_LABELS[slug];
  return (
    <div className="flex max-w-[7.5rem] items-center gap-1 sm:max-w-none sm:gap-1.5">
      <div className="grid size-5 shrink-0 place-items-center overflow-hidden rounded border bg-background sm:size-6">
        <ExchangeIcon slug={slug} className="size-4 sm:size-5" title={label} />
      </div>
      <span className="truncate text-[10px] font-medium leading-tight sm:text-xs">
        {label}
      </span>
    </div>
  );
}

function CoinCell({
  base,
  onHide,
  isSaved,
  onToggleSaved,
}: {
  base: string;
  onHide?: (base: string) => void;
  isSaved?: boolean;
  onToggleSaved?: (base: string) => void;
}) {
  return (
    <span className="group/coin inline-flex items-center gap-1">
      {onToggleSaved && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSaved(base);
          }}
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors",
            "text-muted-foreground/70 hover:bg-amber-500/15 hover:text-amber-600",
            isSaved && "text-amber-600",
          )}
          aria-label={
            isSaved ? `Убрать ${base} из сохранённых` : `Сохранить ${base}`
          }
        >
          <Star
            className={cn("size-3.5", isSaved && "fill-amber-400 text-amber-600")}
          />
        </button>
      )}
      <span className="font-semibold tracking-wide">{base}</span>
      {onHide && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHide(base);
          }}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/coin:opacity-100"
          aria-label={`Скрыть ${base}`}
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}

type CompareSelection = {
  base: string;
  exchangeA: ExchangeAdapterSlug;
  exchangeB: ExchangeAdapterSlug | null;
};

function futuresLink(slug: ExchangeAdapterSlug, base: string): string | null {
  const b = base.toUpperCase();
  switch (slug) {
    case "binance":
      return `https://www.binance.com/en/futures/${b}USDT`;
    case "asterdex":
      return `https://www.asterdex.com/en/futures/v1/${b}USDT`;
    case "bybit":
      return `https://www.bybit.com/trade/usdt/${b}USDT`;
    case "okx":
      return `https://www.okx.com/trade-swap/${b.toLowerCase()}-usdt-swap`;
    case "hyperliquid":
      return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(b)}`;
    case "gate":
      return `https://www.gate.io/futures_trade/USDT/${b}_USDT`;
    case "bitget":
      return `https://www.bitget.com/futures/usdt/${b}USDT`;
    case "kucoin":
      return `https://www.kucoin.com/futures/trade/${b}-USDT`;
    case "mexc":
      return `https://futures.mexc.com/exchange/${b}_USDT?type=linear_swap`;
    case "bingx":
      /** USDⓢ-M perpetual (не linear forward). */
      return `https://bingx.com/en/perpetual/${b}-USDT`;
    case "lbank":
      return `https://www.lbank.com/futures/${b}USDT/`;
    case "xt":
      return `https://www.xt.com/en/futures/trade/${b}_usdt`;
    case "htx":
      return `https://www.htx.com/futures/linear_swap/exchange#contract_code=${b}-USDT`;
    case "kraken":
      return `https://futures.kraken.com/trade/futures/PF_${b}USD`;
    case "bitmart":
      return `https://derivatives.bitmart.com/en-US?symbol=${b}USDT`;
    case "toobit":
      return `https://www.toobit.com/futures/${b}-SWAP-USDT`;
    case "coinw":
      return `https://www.coinw.com/futures/usdt/${b.toLowerCase()}usdt`;
    case "ourbit":
      return `https://futures.ourbit.com/exchange/${b}_USDT`;
    case "zoomex":
      return `https://www.zoomex.com/trade/usdt/${b}USDT`;
    case "coinex":
      return `https://www.coinex.com/futures/${b}-USDT`;
    case "phemex":
      return `https://phemex.com/futures/${b}-USDT`;
    case "bitunix":
      return `https://www.bitunix.com/futures/${b}USDT`;
    case "whitebit":
      return `https://whitebit.com/trade/${b}-PERP`;
    case "tapbit":
      return `https://www.tapbit.com/futures/${b}-SWAP`;
    case "ascendex":
      return `https://ascendex.com/en/futures-perpetualcontract-trading/${b.toLowerCase()}-perp`;
    case "bitrue":
      return `https://www.bitrue.com/futures/${b}`;
    case "blofin":
      return `https://blofin.com/futures/${b}-USDT`;
    case "woox":
      return `https://dex.woo.org/en/trade?symbol=PERP_${b}_USDT`;
    default:
      return null;
  }
}

export function FundingTableView({
  rows,
  isLoading,
  error,
  onHideToken,
  onToggleSaved,
  savedBasesSet,
}: {
  rows: FundingTableRow[];
  isLoading: boolean;
  error: string | null;
  onHideToken?: (base: string) => void;
  onToggleSaved?: (base: string) => void;
  savedBasesSet?: Set<string>;
}) {
  const columnOrder = useFundingUiStore((s) => s.columnOrder);
  const columnVisibility = useFundingUiStore((s) => s.columnVisibility);
  const sortColumn = useFundingUiStore((s) => s.sortColumn);
  const sortDirection = useFundingUiStore((s) => s.sortDirection);
  const setSortColumn = useFundingUiStore((s) => s.setSortColumn);

  const [history, setHistory] = useState<{
    exchange: ExchangeAdapterSlug;
    base: string;
  } | null>(null);

  const [compare, setCompare] = useState<CompareSelection | null>(null);
  const compareOpen = compare !== null && compare.exchangeB !== null;

  function handleCellClick(
    slug: ExchangeAdapterSlug,
    base: string,
    modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
  ) {
    if (modifiers.ctrlOrMetaKey) {
      const url = futuresLink(slug, base);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    if (!modifiers.shiftKey) {
      setCompare(null);
      setHistory({ exchange: slug, base });
      return;
    }

    if (compare && compare.base === base && compare.exchangeB === null) {
      if (slug === compare.exchangeA) return;
      setCompare({ ...compare, exchangeB: slug });
    } else {
      setCompare({ base, exchangeA: slug, exchangeB: null });
    }
  }

  const visibleColumns = useMemo(() => {
    const out: ColumnId[] = ["coins"];
    for (const id of columnOrder) {
      if (id === "coins") continue;
      if (columnVisibility[id] === false) continue;
      out.push(id);
    }
    return out;
  }, [columnOrder, columnVisibility]);

  /** Минимальная ширина таблицы растёт с числом колонок — на широком окне видно больше бирж без лишней «пустой» ширины. */
  const tableMinWidthPx = useMemo(
    () => Math.max(720, 120 + visibleColumns.length * 58),
    [visibleColumns.length],
  );

  const pendingBase = compare && compare.exchangeB === null ? compare.base : null;
  const pendingExchange = compare && compare.exchangeB === null ? compare.exchangeA : null;

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <>
    {pendingBase !== null && (
      <div className="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm dark:border-sky-800 dark:bg-sky-950/40">
        <span className="font-medium text-sky-900 dark:text-sky-200">
          {pendingBase}: выбрана {EXCHANGE_LABELS[pendingExchange!]}
        </span>
        <span className="text-sky-700 dark:text-sky-400">
          — Shift+клик по второй бирже для сравнения · Ctrl/Cmd+клик открыть фьючерсы
        </span>
        <button
          type="button"
          onClick={() => setCompare(null)}
          className="ml-auto rounded-md px-2 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-900/50"
        >
          Отмена
        </button>
      </div>
    )}
    <div className="relative w-full min-w-0 overflow-x-auto overflow-y-auto rounded-lg border bg-card">
      <Table
        className="w-full text-xs [&_th]:h-9 [&_th]:px-1.5 [&_td]:px-1.5 [&_td]:py-1.5"
        style={{
          /** Шире контента — на всю ширину окна; уже — горизонтальный скролл */
          minWidth: `max(100%, ${tableMinWidthPx}px)`,
        }}
      >
        <TableHeader className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <TableRow>
            {visibleColumns.map((id) => {
              const isSticky = id === "coins";
              const label =
                id === "coins" || id === "maxSpread" ? (
                  columnTitle(id)
                ) : (
                  <ExchangeBadge slug={id} />
                );
              return (
                <TableHead
                  key={id}
                  aria-sort={
                    sortColumn === id
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className={cn(
                    "whitespace-nowrap text-xs font-semibold text-muted-foreground",
                    isSticky && "sticky left-0 z-30 bg-background/95 backdrop-blur",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "-mx-1 inline-flex max-w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/80 hover:text-foreground",
                      sortColumn === id && "text-foreground",
                    )}
                    onClick={() => setSortColumn(id)}
                  >
                    <span className="min-w-0 flex-1">{label}</span>
                    {sortColumn === id ? (
                      sortDirection === "asc" ? (
                        <ChevronUp
                          className="size-3.5 shrink-0 opacity-80"
                          aria-hidden
                        />
                      ) : (
                        <ChevronDown
                          className="size-3.5 shrink-0 opacity-80"
                          aria-hidden
                        />
                      )
                    ) : null}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={visibleColumns.length} className="py-10 text-center text-sm text-muted-foreground">
                Загрузка…
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={visibleColumns.length} className="py-10 text-center text-sm text-muted-foreground">
                Нет строк для отображения.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.baseAsset} className="hover:bg-muted/40">
                {visibleColumns.map((col) => {
                  const sticky = col === "coins";
                  return (
                    <TableCell
                      key={col}
                      className={cn(
                        "whitespace-nowrap py-2 text-xs tabular-nums",
                        sticky && "sticky left-0 z-10 bg-card",
                      )}
                    >
                      <CellRenderer
                        col={col}
                        row={row}
                        onCellClick={handleCellClick}
                        onHideToken={onHideToken}
                        onToggleSaved={onToggleSaved}
                        savedBasesSet={savedBasesSet}
                        pendingExchange={
                          pendingBase === row.baseAsset
                            ? pendingExchange
                            : null
                        }
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
    <FundingHistoryDialog
      open={history !== null}
      onOpenChange={(o) => {
        if (!o) setHistory(null);
      }}
      exchange={history?.exchange ?? null}
      baseAsset={history?.base ?? null}
    />
    <FundingCompareDialog
      open={compareOpen}
      onOpenChange={(o) => {
        if (!o) setCompare(null);
      }}
      baseAsset={compare?.base ?? null}
      initialExchangeA={compare?.exchangeA ?? null}
      initialExchangeB={compare?.exchangeB ?? null}
    />
    </>
  );
}

function CellRenderer({
  col,
  row,
  onCellClick,
  onHideToken,
  onToggleSaved,
  savedBasesSet,
  pendingExchange,
}: {
  col: ColumnId;
  row: FundingTableRow;
  onCellClick: (
    slug: ExchangeAdapterSlug,
    base: string,
    modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
  ) => void;
  onHideToken?: (base: string) => void;
  onToggleSaved?: (base: string) => void;
  savedBasesSet?: Set<string>;
  pendingExchange: ExchangeAdapterSlug | null;
}) {
  if (col === "coins")
    return (
      <CoinCell
        base={row.baseAsset}
        onHide={onHideToken}
        isSaved={savedBasesSet?.has(row.baseAsset)}
        onToggleSaved={onToggleSaved}
      />
    );

  if (col === "maxSpread") {
    const v = row.maxSpread;
    return (
      <span className={fundingCellClass(v)}>{formatFundingPercent(v)}</span>
    );
  }

  const slug = col as ExchangeAdapterSlug;
  const v = row.ratesByExchange[slug] ?? null;
  const intervalH =
    row.fundingIntervalHoursByExchange?.[slug] ?? undefined;
  const intervalLabel = formatFundingIntervalShortLabel(intervalH);
  const label = EXCHANGE_LABELS[slug];
  const isSelected = slug === pendingExchange;
  const spreadExtremes = row.maxSpreadSlugs ?? [];
  const isSpreadExtreme = spreadExtremes.includes(slug);
  return (
    <button
      type="button"
      className={cn(
        "-mx-1 w-full min-w-[4.25rem] rounded-md px-1.5 py-1 text-left transition-colors",
        "hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        isSpreadExtreme &&
          !isSelected &&
          "bg-amber-500/12 shadow-[0_0_14px_rgba(245,158,11,0.35)] ring-1 ring-amber-500/55 dark:bg-amber-400/10 dark:shadow-[0_0_18px_rgba(251,191,36,0.22)] dark:ring-amber-400/45",
        isSpreadExtreme &&
          isSelected &&
          "shadow-[0_0_12px_rgba(245,158,11,0.3)] ring-2 ring-sky-400 bg-sky-50 dark:bg-sky-950/40 dark:ring-sky-600",
        isSelected &&
          !isSpreadExtreme &&
          "ring-2 ring-sky-400 bg-sky-50 dark:bg-sky-950/40 dark:ring-sky-600",
        fundingCellClass(v),
      )}
      onClick={(e) =>
        onCellClick(slug, row.baseAsset, {
          shiftKey: e.shiftKey,
          ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        })
      }
      aria-label={`История фандинга ${row.baseAsset} на ${label}`}
    >
      <span className="inline-flex flex-wrap items-baseline gap-x-1 gap-y-0">
        <span>{formatFundingPercent(v)}</span>
        {intervalLabel ? (
          <span className="text-[10px] font-normal text-muted-foreground">
            {intervalLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}
