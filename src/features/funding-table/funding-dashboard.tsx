"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { FundingPeriod } from "@/lib/services/funding-table";
import type { FundingPeriodUi } from "@/features/funding-table/funding-ui-store";
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

export function FundingDashboard() {
  const period = useFundingUiStore((s) => s.period);
  const page = useFundingUiStore((s) => s.page);
  const pageSize = useFundingUiStore((s) => s.pageSize);
  const search = useFundingUiStore((s) => s.search);
  const columnVisibility = useFundingUiStore((s) => s.columnVisibility);
  const setPage = useFundingUiStore((s) => s.setPage);

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

  const query = useQuery({
    queryKey: [
      "funding-table",
      period,
      page,
      pageSize,
      search,
      visibleExchanges.join("|"),
      sortColumn,
      sortDirection,
      dashboardMainTab,
      dashboardMainTab === "saved" ? orderedSavedBases.join(",") : "",
    ],
    enabled: savedQueryEnabled,
    staleTime: period === "now" ? 42_000 : 120_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("period", mapPeriod(period));
      if (dashboardMainTab === "saved" && orderedSavedBases.length > 0) {
        params.set("page", "1");
        params.set(
          "pageSize",
          String(Math.min(500, Math.max(orderedSavedBases.length, 5))),
        );
        params.set("bases", orderedSavedBases.join(","));
      } else {
        params.set("page", String(page));
        params.set("pageSize", String(pageSize));
        if (search.trim()) params.set("q", search.trim());
      }
      params.set("visible", visibleExchanges.join(","));
      params.set("sort", sortColumn);
      params.set("dir", sortDirection);
      const res = await fetch(`/api/funding/table?${params.toString()}`);
      if (!res.ok) throw new Error("Не удалось загрузить данные");
      return (await res.json()) as {
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
        };
      };
    },
    refetchInterval: period === "now" ? 50_000 : 180_000,
  });

  const filteredRows = useMemo(() => {
    let rows = query.data?.rows ?? [];
    if (
      dashboardMainTab === "saved" &&
      orderedSavedBases.length > 0 &&
      rows.length > 0
    ) {
      const m = new Map(rows.map((r) => [r.baseAsset, r]));
      rows = orderedSavedBases
        .map((b) => m.get(b))
        .filter((r): r is NonNullable<typeof r> => r != null);
    }
    if (hiddenSet.size === 0) return rows;
    return rows.filter((r) => !hiddenSet.has(r.baseAsset));
  }, [
    query.data?.rows,
    hiddenSet,
    dashboardMainTab,
    orderedSavedBases,
  ]);

  const searchNeedle = search.trim().toLowerCase();
  const displayRows = useMemo(() => {
    if (!searchNeedle || dashboardMainTab === "all") return filteredRows;
    return filteredRows.filter((r) =>
      r.baseAsset.toLowerCase().includes(searchNeedle),
    );
  }, [filteredRows, searchNeedle, dashboardMainTab]);

  const filteredTotal =
    dashboardMainTab === "saved"
      ? displayRows.length
      : Math.max(0, (query.data?.total ?? 0) - hiddenSet.size);

  const effectivePageSize = query.data?.pageSize ?? pageSize;
  const totalPages =
    dashboardMainTab === "saved"
      ? 1
      : Math.max(1, Math.ceil(filteredTotal / effectivePageSize));

  const pages = useMemo(() => {
    const cur = query.data?.page ?? page;
    const windowSize = 5;
    const start = Math.max(1, cur - Math.floor(windowSize / 2));
    const end = Math.min(totalPages, start + windowSize - 1);
    const s2 = Math.max(1, end - windowSize + 1);
    const out: number[] = [];
    for (let i = s2; i <= end; i++) out.push(i);
    return out;
  }, [query.data?.page, page, totalPages]);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6">
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
          total={query.data.total}
          meta={query.data.meta}
          hasSearch={Boolean(search.trim())}
        />
      ) : null}

      {(dashboardMainTab === "all" || orderedSavedBases.length > 0) && (
        <FundingTableView
          rows={displayRows}
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
            ? `Сохранённых: ${orderedSavedBases.length} · в таблице: ${displayRows.length}`
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
                variant={p === (query.data?.page ?? page) ? "default" : "outline"}
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
