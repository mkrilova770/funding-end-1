"use client";

import { Search, Star, Trash2 } from "lucide-react";
import { ColumnSettingsDialog } from "@/features/funding-table/column-settings-dialog";
import {
  type DashboardMainTab,
  useFundingUiStore,
} from "@/features/funding-table/funding-ui-store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function FundingControls() {
  const period = useFundingUiStore((s) => s.period);
  const setPeriod = useFundingUiStore((s) => s.setPeriod);
  const search = useFundingUiStore((s) => s.search);
  const setSearch = useFundingUiStore((s) => s.setSearch);
  const hiddenCount = useFundingUiStore((s) => s.hiddenTokens.length);
  const setTrashOpen = useFundingUiStore((s) => s.setTrashOpen);
  const dashboardMainTab = useFundingUiStore((s) => s.dashboardMainTab);
  const setDashboardMainTab = useFundingUiStore((s) => s.setDashboardMainTab);
  const savedCount = useFundingUiStore((s) => s.savedTokens.length);

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        value={dashboardMainTab}
        onValueChange={(v) => setDashboardMainTab(v as DashboardMainTab)}
        className="w-full max-w-md"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="all">Все монеты</TabsTrigger>
          <TabsTrigger value="saved" className="gap-1.5">
            <Star className="size-3.5 opacity-80" />
            Сохранённые
            {savedCount > 0 ? (
              <span className="tabular-nums text-muted-foreground">({savedCount})</span>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            dashboardMainTab === "saved"
              ? "Фильтр по тикеру в таблице…"
              : "Поиск криптовалюты..."
          }
          className="pl-9"
          aria-label="Поиск по тикеру"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={period}
          onValueChange={(v) => setPeriod(v as typeof period)}
          className="w-auto"
        >
          <TabsList>
            <TabsTrigger value="now">Сейчас</TabsTrigger>
            <TabsTrigger value="week">Неделя</TabsTrigger>
            <TabsTrigger value="month">Месяц</TabsTrigger>
          </TabsList>
        </Tabs>

        {hiddenCount > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setTrashOpen(true)}
            className="gap-1.5"
          >
            <Trash2 className="size-4" />
            <span className="tabular-nums">{hiddenCount}</span>
          </Button>
        )}

        <ColumnSettingsDialog />
      </div>
      </div>
    </div>
  );
}
