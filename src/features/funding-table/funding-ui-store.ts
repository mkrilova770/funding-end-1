import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import type {
  FundingTableSortDir,
  FundingTableSortKey,
} from "@/lib/services/funding-table";
import { arrayMove } from "@dnd-kit/sortable";

export type FundingPeriodUi = "now" | "week" | "month";

export type ColumnId = "coins" | "maxSpread" | ExchangeAdapterSlug;

export function defaultColumnOrder(): ColumnId[] {
  return ["coins", "maxSpread", ...ALL_EXCHANGE_SLUGS];
}

function defaultColumnVisibility(): Record<ColumnId, boolean> {
  return Object.fromEntries(
    defaultColumnOrder().map((id) => [id, true]),
  ) as Record<ColumnId, boolean>;
}

type State = {
  search: string;
  period: FundingPeriodUi;
  page: number;
  pageSize: number;
  sortColumn: FundingTableSortKey;
  sortDirection: FundingTableSortDir;
  columnOrder: ColumnId[];
  columnVisibility: Record<ColumnId, boolean>;
  settingsOpen: boolean;
  hiddenTokens: string[];
  trashOpen: boolean;

  setSearch: (v: string) => void;
  setPeriod: (v: FundingPeriodUi) => void;
  setPage: (v: number) => void;
  setPageSize: (v: number) => void;
  setSettingsOpen: (v: boolean) => void;
  setSortColumn: (col: FundingTableSortKey) => void;
  hideToken: (base: string) => void;
  restoreToken: (base: string) => void;
  restoreAllTokens: () => void;
  setTrashOpen: (v: boolean) => void;

  toggleColumnVisibility: (id: ColumnId) => void;
  reorderColumns: (activeId: ColumnId, overId: ColumnId) => void;
};

export const useFundingUiStore = create<State>()(
  persist(
    (set) => ({
      search: "",
      period: "now",
      page: 1,
      pageSize: 50,
      sortColumn: "maxSpread",
      sortDirection: "desc",
      columnOrder: defaultColumnOrder(),
      columnVisibility: defaultColumnVisibility(),
      settingsOpen: false,
      hiddenTokens: [],
      trashOpen: false,

      setSearch: (v) => set({ search: v, page: 1 }),
      setPeriod: (v) => set({ period: v, page: 1 }),
      setPage: (v) => set({ page: Math.max(1, v) }),
      setPageSize: (v) => set({ pageSize: Math.min(200, Math.max(5, v)), page: 1 }),
      setSettingsOpen: (v) => set({ settingsOpen: v }),

      setSortColumn: (col) =>
        set((s) => {
          if (col === s.sortColumn) {
            return {
              sortDirection: s.sortDirection === "asc" ? "desc" : "asc",
              page: 1,
            };
          }
          const sortDirection: FundingTableSortDir =
            col === "coins" ? "asc" : "desc";
          return { sortColumn: col, sortDirection, page: 1 };
        }),

      hideToken: (base) =>
        set((s) =>
          s.hiddenTokens.includes(base)
            ? s
            : { hiddenTokens: [...s.hiddenTokens, base] },
        ),
      restoreToken: (base) =>
        set((s) => ({
          hiddenTokens: s.hiddenTokens.filter((t) => t !== base),
        })),
      restoreAllTokens: () => set({ hiddenTokens: [] }),
      setTrashOpen: (v) => set({ trashOpen: v }),

      toggleColumnVisibility: (id) => {
        if (id === "coins") return;
        set((s) => ({
          columnVisibility: {
            ...s.columnVisibility,
            [id]: !s.columnVisibility[id],
          },
        }));
      },

      reorderColumns: (activeId, overId) => {
        if (activeId === "coins" || overId === "coins") return;
        set((s) => {
          const oldIndex = s.columnOrder.indexOf(activeId);
          const newIndex = s.columnOrder.indexOf(overId);
          if (oldIndex < 0 || newIndex < 0) return s;
          const next = arrayMove(s.columnOrder, oldIndex, newIndex);
          const coinsIdx = next.indexOf("coins");
          if (coinsIdx !== 0) {
            next.splice(coinsIdx, 1);
            next.unshift("coins");
          }
          return { columnOrder: next };
        });
      },
    }),
    {
      name: "funding-dashboard-ui",
      partialize: (s) => ({
        search: s.search,
        period: s.period,
        pageSize: s.pageSize,
        sortColumn: s.sortColumn,
        sortDirection: s.sortDirection,
        columnOrder: s.columnOrder,
        columnVisibility: s.columnVisibility,
        hiddenTokens: s.hiddenTokens,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<State>;
        let columnOrder = (p.columnOrder ?? current.columnOrder).filter(
          (id) => (id as string) !== "history",
        ) as ColumnId[];
        if (!columnOrder.length) columnOrder = defaultColumnOrder();
        if (columnOrder[0] !== "coins") {
          columnOrder = [
            "coins",
            ...columnOrder.filter((id) => id !== "coins"),
          ];
        }
        const vis: Record<ColumnId, boolean> = { ...defaultColumnVisibility() };
        if (p.columnVisibility) {
          const allowed = new Set<ColumnId>(defaultColumnOrder());
          for (const [k, v] of Object.entries(p.columnVisibility)) {
            if (k === "history") continue;
            if (allowed.has(k as ColumnId)) vis[k as ColumnId] = Boolean(v);
          }
        }
        return {
          ...current,
          ...p,
          columnOrder,
          columnVisibility: vis,
          hiddenTokens: Array.isArray(p.hiddenTokens) ? p.hiddenTokens : [],
        };
      },
    },
  ),
);

export function columnTitle(id: ColumnId): string {
  switch (id) {
    case "coins":
      return "Монеты";
    case "maxSpread":
      return "Макс. спред";
    default:
      return id;
  }
}
