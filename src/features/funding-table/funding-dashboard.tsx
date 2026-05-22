"use client";

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import {
  emptyFundingTableRow,
  sortFundingTableRows,
  withPinnedMajorsFirst,
  type FundingPeriod,
  type FundingTableSortDir,
  type FundingTableSortKey,
} from "@/lib/services/funding-table";
import type {
  DashboardMainTab,
  FundingPeriodUi,
} from "@/features/funding-table/funding-ui-store";
import {
  getOrderedSavedBases,
  useFundingUiStore,
} from "@/features/funding-table/funding-ui-store";
import { EmptyDataHint } from "@/features/funding-table/empty-data-hint";
import { FundingControls } from "@/features/funding-table/funding-controls";
import { FundingTableView } from "@/features/funding-table/funding-table";
import { SavedTokensWorkspace } from "@/features/funding-table/saved-tokens-workspace";
import { TrashBinDialog } from "@/features/funding-table/trash-bin-dialog";
import { TelegramNotifySettingsDialog } from "@/features/funding-table/telegram-notify-settings-dialog";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

function mapPeriod(p: FundingPeriodUi): FundingPeriod {
  return p;
}

type FundingTablePayload = {
  updatedAt: string | null;
  total: number;
  page: number;
  pageSize: number;
  rows: import("@/lib/services/funding-table").FundingTableRow[];
  meta: {
    exchangeCount: number;
    marketCount: number;
    live?: boolean;
    needsHistoryDb?: boolean;
    fullList?: boolean;
  };
};

async function fetchFundingTablePayload(input: {
  period: FundingPeriod;
  page: number;
  pageSize: number;
  search: string;
  /** Список slug через запятую для query `visible=` (только запятая — см. parseVisible на сервере). */
  visibleParam: string;
  sortColumn: FundingTableSortKey;
  sortDirection: FundingTableSortDir;
  dashboardMainTab: DashboardMainTab;
  orderedSavedBases: string[];
}): Promise<FundingTablePayload> {
  const params = new URLSearchParams();
  params.set("period", input.period);
  const nowFullList = input.period === "now";
  if (nowFullList) params.set("full", "1");
  if (
    input.dashboardMainTab === "saved" &&
    input.orderedSavedBases.length > 0
  ) {
    params.set("page", "1");
    params.set(
      "pageSize",
      String(Math.min(500, Math.max(input.orderedSavedBases.length, 5))),
    );
    params.set("bases", input.orderedSavedBases.join(","));
  } else {
    params.set("page", nowFullList ? "1" : String(input.page));
    params.set(
      "pageSize",
      nowFullList ? "5000" : String(input.pageSize),
    );
    if (input.search.trim()) params.set("q", input.search.trim());
  }
  params.set("visible", input.visibleParam);
  if (!nowFullList) {
    params.set("sort", input.sortColumn);
    params.set("dir", input.sortDirection);
  } else if (input.dashboardMainTab === "all") {
    /** Сервер при full=1 не сортирует; передаём дефолт для совместимости логов/кэша. */
    params.set("sort", "maxSpread");
    params.set("dir", "desc");
  }
  const res = await fetch(`/api/funding/table?${params.toString()}`);
  if (!res.ok) {
    const hint = await res.text().catch(() => "");
    throw new Error(
      `Не удалось загрузить данные (HTTP ${res.status})${hint ? `: ${hint.slice(0, 160)}` : ""}`,
    );
  }
  return (await res.json()) as FundingTablePayload;
}

export function FundingDashboard() {
  const queryClient = useQueryClient();
  const period = useFundingUiStore((s) => s.period);
  const page = useFundingUiStore((s) => s.page);
  const pageSize = useFundingUiStore((s) => s.pageSize);
  const search = useFundingUiStore((s) => s.search);
  const columnVisibility = useFundingUiStore((s) => s.columnVisibility);
  const setPage = useFundingUiStore((s) => s.setPage);
  const setSortColumn = useFundingUiStore((s) => s.setSortColumn);

  const sortColumn = useFundingUiStore((s) => s.sortColumn);
  const sortDirection = useFundingUiStore((s) => s.sortDirection);
  const hiddenTokens = useFundingUiStore((s) => s.hiddenTokens);
  const hideToken = useFundingUiStore((s) => s.hideToken);
  const dashboardMainTab = useFundingUiStore((s) => s.dashboardMainTab);
  const savedFolders = useFundingUiStore((s) => s.savedFolders);
  const savedTokens = useFundingUiStore((s) => s.savedTokens);
  const toggleSavedToken = useFundingUiStore((s) => s.toggleSavedToken);

  const hiddenSet = useMemo(() => new Set(hiddenTokens), [hiddenTokens]);

  const orderedSavedBases = useMemo(
    () => getOrderedSavedBases(savedFolders, savedTokens),
    [savedFolders, savedTokens],
  );

  const savedBasesSet = useMemo(
    () => new Set(savedTokens.map((t) => t.base)),
    [savedTokens],
  );

  const visibleExchanges = useMemo(() => {
    return ALL_EXCHANGE_SLUGS.filter((slug) => columnVisibility[slug] !== false);
  }, [columnVisibility]);

  const savedQueryEnabled =
    dashboardMainTab === "all" || orderedSavedBases.length > 0;

  const savedBasesKey =
    dashboardMainTab === "saved" ? orderedSavedBases.join(",") : "";
  const visibleParam = visibleExchanges.join(",");

  /** Сортировка по колонке скрытой биржи даёт пустые значения — сбрасываем на «Макс. спред». */
  useEffect(() => {
    if (
      sortColumn === "coins" ||
      sortColumn === "maxSpread" ||
      sortColumn === "maxFunding" ||
      sortColumn === "minFunding"
    ) {
      return;
    }
    if (!visibleExchanges.includes(sortColumn as ExchangeAdapterSlug)) {
      setSortColumn("maxSpread");
    }
  }, [sortColumn, visibleExchanges, setSortColumn]);

  /** Не грузим тяжёлые период-агрегации при первом заходе: это тормозит открытие главной страницы. */
  useEffect(() => {
    if (period !== "now" || !savedQueryEnabled) return;
    return;
  }, [
    period,
    savedQueryEnabled,
  ]);

  const liveNowShortQueryKey = period === "now";

  const query = useQuery({
    queryKey: liveNowShortQueryKey
      ? [
          "funding-table",
          period,
          pageSize,
          search,
          visibleParam,
          dashboardMainTab,
          savedBasesKey,
        ]
      : [
          "funding-table",
          period,
          page,
          pageSize,
          search,
          visibleParam,
          sortColumn,
          sortDirection,
          dashboardMainTab,
          savedBasesKey,
        ],
    enabled: savedQueryEnabled,
    staleTime: period === "now" ? 55_000 : 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: period === "now" ? 0 : 1,
    retryDelay: 4000,
    queryFn: () =>
      fetchFundingTablePayload({
        period: mapPeriod(period),
        page,
        pageSize,
        search,
        visibleParam,
        sortColumn,
        sortDirection,
        dashboardMainTab,
        orderedSavedBases,
      }),
    refetchInterval: period === "now" ? 50_000 : 180_000,
  });

  const filteredRows = useMemo(() => {
    let rows = query.data?.rows ?? [];
    if (dashboardMainTab === "saved" && orderedSavedBases.length > 0) {
      const m = new Map(rows.map((r) => [r.baseAsset, r]));
      rows = orderedSavedBases.map((b) => {
        const hit = m.get(b);
        if (hit) return hit;
        return emptyFundingTableRow(b, visibleExchanges);
      });
    }
    if (hiddenSet.size === 0) return rows;
    return rows.filter((r) => !hiddenSet.has(r.baseAsset));
  }, [
    query.data?.rows,
    hiddenSet,
    dashboardMainTab,
    orderedSavedBases,
    visibleExchanges,
  ]);

  const searchNeedle = search.trim().toLowerCase();
  const searchFilteredRows = useMemo(() => {
    if (!searchNeedle) return filteredRows;
    return filteredRows.filter((r) =>
      r.baseAsset.toLowerCase().includes(searchNeedle),
    );
  }, [filteredRows, searchNeedle]);

  const clientSortedRows = useMemo(() => {
    if (period !== "now" || dashboardMainTab !== "all") {
      return searchFilteredRows;
    }
    const q = search.trim() || undefined;
    return sortFundingTableRows(
      withPinnedMajorsFirst(searchFilteredRows, { q }),
      sortColumn,
      sortDirection,
    );
  }, [
    period,
    dashboardMainTab,
    searchFilteredRows,
    sortColumn,
    sortDirection,
    search,
  ]);

  const tableRows = useMemo(() => {
    if (period !== "now" || dashboardMainTab !== "all") {
      return searchFilteredRows;
    }
    const start = (page - 1) * pageSize;
    return clientSortedRows.slice(start, start + pageSize);
  }, [
    period,
    dashboardMainTab,
    searchFilteredRows,
    clientSortedRows,
    page,
    pageSize,
  ]);

  const filteredTotal =
    dashboardMainTab === "saved"
      ? searchFilteredRows.length
      : period === "now" && dashboardMainTab === "all"
        ? searchFilteredRows.length
        : Math.max(0, (query.data?.total ?? 0) - hiddenSet.size);

  const effectivePageSize =
    period === "now" && dashboardMainTab === "all"
      ? pageSize
      : (query.data?.pageSize ?? pageSize);
  const totalPages =
    dashboardMainTab === "saved"
      ? 1
      : Math.max(1, Math.ceil(filteredTotal / effectivePageSize));

  const pages = useMemo(() => {
    const cur = page;
    const windowSize = 5;
    const start = Math.max(1, cur - Math.floor(windowSize / 2));
    const end = Math.min(totalPages, start + windowSize - 1);
    const s2 = Math.max(1, end - windowSize + 1);
    const out: number[] = [];
    for (let i = s2; i <= end; i++) out.push(i);
    return out;
  }, [page, totalPages]);

  useEffect(() => {
    if (dashboardMainTab !== "all") return;
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages, setPage, dashboardMainTab]);

  /**
   * Только серверный total: иначе при «Сейчас» + fullList после скрытия всех видимых
   * строк searchFilteredRows.length === 0 при живом ответе API — ложное «ни с одной биржи».
   */
  const emptyHintTotal = query.data?.total ?? 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 px-2 py-6 sm:px-4 lg:px-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Отслеживание фандинга криптовалют
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <TelegramNotifySettingsDialog />
            <ThemeToggle />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>USDT perpetual</span>
          <span className="hidden sm:inline">·</span>
          <span>
            Обновлено:{" "}
            {query.data?.updatedAt
              ? new Date(query.data.updatedAt).toLocaleString("ru-RU")
              : "—"}
          </span>
          {query.data?.meta?.live ? (
            <>
              <span className="hidden sm:inline">·</span>
              <span className="text-emerald-700 dark:text-emerald-400">
                Режим «Сейчас»: данные с бирж, кэш ~45 с
              </span>
            </>
          ) : null}
        </div>
      </div>

      <FundingControls />

      {dashboardMainTab === "saved" && orderedSavedBases.length > 0 ? (
        <SavedTokensWorkspace />
      ) : null}

      {dashboardMainTab === "saved" && orderedSavedBases.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          В «Сохранённых» пока пусто. На вкладке «Все монеты» нажмите звёздочку у тикера, чтобы добавить
          монету сюда, затем настройте папки и порядок на этой вкладке.
        </div>
      ) : null}

      {!query.isLoading && query.isSuccess && dashboardMainTab === "all" ? (
        <EmptyDataHint
          period={period}
          total={emptyHintTotal}
          meta={query.data.meta}
          hasSearch={Boolean(search.trim())}
        />
      ) : null}

      {(dashboardMainTab === "all" || orderedSavedBases.length > 0) && (
        <FundingTableView
          rows={tableRows}
          isLoading={savedQueryEnabled && query.isLoading}
          error={query.error ? (query.error as Error).message : null}
          onHideToken={hideToken}
          onToggleSaved={toggleSavedToken}
          savedBasesSet={savedBasesSet}
        />
      )}
      <TrashBinDialog />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted-foreground">
          {dashboardMainTab === "saved"
            ? `Сохранённых: ${orderedSavedBases.length} · в таблице: ${searchFilteredRows.length}`
            : `Всего монет: ${filteredTotal}`}
        </div>

        {dashboardMainTab === "all" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage(page - 1)}
            >
              Назад
            </Button>

            {pages.map((p) => (
              <Button
                key={p}
                type="button"
                variant={p === page ? "default" : "outline"}
                size="sm"
                className="min-w-9"
                disabled={query.isFetching}
                onClick={() => setPage(p)}
              >
                {p}
              </Button>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages || query.isFetching}
              onClick={() => setPage(page + 1)}
            >
              Вперёд
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
