"use client";

import { Search, Trash2 } from "lucide-react";
import { ColumnSettingsDialog } from "@/features/funding-table/column-settings-dialog";
import { useFundingUiStore } from "@/features/funding-table/funding-ui-store";
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

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск криптовалюты..."
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
  );
}
