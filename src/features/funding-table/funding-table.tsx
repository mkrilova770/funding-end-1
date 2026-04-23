"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
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
} from "@/lib/formatters/funding";
import type { FundingTableRow } from "@/lib/services/funding-table";
import type { ColumnId } from "@/features/funding-table/funding-ui-store";
import { columnTitle, useFundingUiStore } from "@/features/funding-table/funding-ui-store";
import { cn } from "@/lib/utils";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";

function ExchangeBadge({ slug }: { slug: ExchangeAdapterSlug }) {
  const label = EXCHANGE_LABELS[slug];
  return (
    <div className="flex items-center gap-2">
      <div className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border bg-background">
        <ExchangeIcon slug={slug} className="size-5" title={label} />
      </div>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function CoinCell({
  base,
  onHide,
}: {
  base: string;
  onHide?: (base: string) => void;
}) {
  return (
    <span className="group/coin inline-flex items-center gap-1">
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

export function FundingTableView({
  rows,
  isLoading,
  error,
  onHideToken,
}: {
  rows: FundingTableRow[];
  isLoading: boolean;
  error: string | null;
  onHideToken?: (base: string) => void;
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
    shiftKey: boolean,
  ) {
    if (!shiftKey) {
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
          — Shift+клик по второй бирже для сравнения
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
    <div className="relative overflow-auto rounded-lg border bg-card">
      <Table className="min-w-[1100px]">
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
  pendingExchange,
}: {
  col: ColumnId;
  row: FundingTableRow;
  onCellClick: (
    slug: ExchangeAdapterSlug,
    base: string,
    shiftKey: boolean,
  ) => void;
  onHideToken?: (base: string) => void;
  pendingExchange: ExchangeAdapterSlug | null;
}) {
  if (col === "coins") return <CoinCell base={row.baseAsset} onHide={onHideToken} />;

  if (col === "maxSpread") {
    const v = row.maxSpread;
    return (
      <span className={fundingCellClass(v)}>{formatFundingPercent(v)}</span>
    );
  }

  const slug = col as ExchangeAdapterSlug;
  const v = row.ratesByExchange[slug] ?? null;
  const label = EXCHANGE_LABELS[slug];
  const isSelected = slug === pendingExchange;
  return (
    <button
      type="button"
      className={cn(
        "-mx-1 w-full min-w-[4.25rem] rounded-md px-1.5 py-1 text-left transition-colors",
        "hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        isSelected
          ? "ring-2 ring-sky-400 bg-sky-50 dark:bg-sky-950/40 dark:ring-sky-600"
          : "",
        fundingCellClass(v),
      )}
      onClick={(e) => onCellClick(slug, row.baseAsset, e.shiftKey)}
      aria-label={`История фандинга ${row.baseAsset} на ${label}`}
    >
      {formatFundingPercent(v)}
    </button>
  );
}
