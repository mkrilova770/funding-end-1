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

export type DashboardMainTab = "all" | "saved";

export type SavedFolder = { id: string; name: string; order: number };

export type SavedTokenEntry = {
  base: string;
  folderId: string | null;
  order: number;
};

function newFolderId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Порядок строк таблицы: сначала «без папки», затем папки по `order`. */
export function getOrderedSavedBases(
  savedFolders: SavedFolder[],
  savedTokens: SavedTokenEntry[],
): string[] {
  const rootToks = savedTokens
    .filter((t) => t.folderId === null)
    .sort((a, b) => a.order - b.order);
  const out = rootToks.map((t) => t.base);
  const folders = [...savedFolders].sort((a, b) => a.order - b.order);
  for (const f of folders) {
    const toks = savedTokens
      .filter((t) => t.folderId === f.id)
      .sort((a, b) => a.order - b.order);
    for (const t of toks) out.push(t.base);
  }
  return out;
}

function normalizeSavedTokenRow(
  raw: unknown,
): SavedTokenEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = typeof o.base === "string" ? o.base.trim().toUpperCase() : "";
  if (!base || !/^[A-Z0-9]{1,32}$/.test(base)) return null;
  const folderId =
    o.folderId === null || o.folderId === undefined
      ? null
      : typeof o.folderId === "string"
        ? o.folderId
        : null;
  const order = Number(o.order);
  return {
    base,
    folderId,
    order: Number.isFinite(order) ? order : 0,
  };
}

function normalizeSavedFolderRow(raw: unknown): SavedFolder | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  if (!id || !name) return null;
  const order = Number(o.order);
  return { id, name, order: Number.isFinite(order) ? order : 0 };
}

function compactTokenOrders(tokens: SavedTokenEntry[]): SavedTokenEntry[] {
  const map = new Map<string, SavedTokenEntry[]>();
  for (const t of tokens) {
    const k = t.folderId === null ? "__root__" : t.folderId;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  const out: SavedTokenEntry[] = [];
  for (const group of map.values()) {
    group.sort((a, b) => a.order - b.order);
    group.forEach((t, i) => out.push({ ...t, order: i }));
  }
  return out;
}

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
  dashboardMainTab: DashboardMainTab;
  savedFolders: SavedFolder[];
  savedTokens: SavedTokenEntry[];

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

  setDashboardMainTab: (v: DashboardMainTab) => void;
  toggleSavedToken: (base: string) => void;
  removeSavedToken: (base: string) => void;
  addSavedFolder: (name: string) => void;
  renameSavedFolder: (id: string, name: string) => void;
  deleteSavedFolder: (id: string) => void;
  reorderSavedFolders: (activeId: string, overId: string) => void;
  setSavedTokenFolder: (base: string, folderId: string | null) => void;
  reorderSavedTokensInFolder: (
    folderId: string | null,
    activeBase: string,
    overBase: string,
  ) => void;

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
      dashboardMainTab: "all",
      savedFolders: [],
      savedTokens: [],

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

      setDashboardMainTab: (v) => set({ dashboardMainTab: v, page: 1 }),

      toggleSavedToken: (base) =>
        set((s) => {
          const b = base.trim().toUpperCase();
          if (!b || !/^[A-Z0-9]{1,32}$/.test(b)) return s;
          const exists = s.savedTokens.some((t) => t.base === b);
          if (exists) {
            return { savedTokens: s.savedTokens.filter((t) => t.base !== b) };
          }
          const root = s.savedTokens.filter((t) => t.folderId === null);
          const nextOrder =
            root.length === 0 ? 0 : Math.max(...root.map((t) => t.order)) + 1;
          return {
            savedTokens: [
              ...s.savedTokens,
              { base: b, folderId: null, order: nextOrder },
            ],
          };
        }),

      removeSavedToken: (base) =>
        set((s) => ({
          savedTokens: s.savedTokens.filter(
            (t) => t.base !== base.trim().toUpperCase(),
          ),
        })),

      addSavedFolder: (name) =>
        set((s) => {
          const nm = (name.trim() || "Новая папка").slice(0, 80);
          const nextOrder =
            s.savedFolders.length === 0
              ? 0
              : Math.max(...s.savedFolders.map((f) => f.order)) + 1;
          return {
            savedFolders: [
              ...s.savedFolders,
              { id: newFolderId(), name: nm, order: nextOrder },
            ],
          };
        }),

      renameSavedFolder: (id, name) =>
        set((s) => ({
          savedFolders: s.savedFolders.map((f) =>
            f.id === id ? { ...f, name: (name.trim() || f.name).slice(0, 80) } : f,
          ),
        })),

      deleteSavedFolder: (id) =>
        set((s) => {
          const folderIds = new Set(s.savedFolders.map((f) => f.id));
          const tokens = s.savedTokens.map((t) =>
            t.folderId === id ? { ...t, folderId: null } : t,
          );
          const fixed = tokens.map((t) =>
            t.folderId !== null && !folderIds.has(t.folderId)
              ? { ...t, folderId: null }
              : t,
          );
          return {
            savedFolders: s.savedFolders.filter((f) => f.id !== id),
            savedTokens: compactTokenOrders(fixed),
          };
        }),

      reorderSavedFolders: (activeId, overId) =>
        set((s) => {
          const oldIndex = s.savedFolders.findIndex((f) => f.id === activeId);
          const newIndex = s.savedFolders.findIndex((f) => f.id === overId);
          if (oldIndex < 0 || newIndex < 0) return s;
          const moved = arrayMove(s.savedFolders, oldIndex, newIndex).map(
            (f, i) => ({ ...f, order: i }),
          );
          return { savedFolders: moved };
        }),

      setSavedTokenFolder: (base, folderId) =>
        set((s) => {
          const b = base.trim().toUpperCase();
          const folderIds = new Set(s.savedFolders.map((f) => f.id));
          const target =
            folderId !== null && !folderIds.has(folderId) ? null : folderId;
          const tokens = s.savedTokens.map((t) =>
            t.base === b ? { ...t, folderId: target } : t,
          );
          return { savedTokens: compactTokenOrders(tokens) };
        }),

      reorderSavedTokensInFolder: (folderId, activeBase, overBase) =>
        set((s) => {
          const inFolder = s.savedTokens
            .filter((t) => t.folderId === folderId)
            .sort((a, b) => a.order - b.order);
          const bases = inFolder.map((t) => t.base);
          const oi = bases.indexOf(activeBase);
          const ni = bases.indexOf(overBase);
          if (oi < 0 || ni < 0) return s;
          const newBases = arrayMove(bases, oi, ni);
          const pos = new Map(newBases.map((bb, i) => [bb, i]));
          const tokens = s.savedTokens.map((t) => {
            if (t.folderId !== folderId) return t;
            const p = pos.get(t.base);
            if (p === undefined) return t;
            return { ...t, order: p };
          });
          return { savedTokens: tokens };
        }),

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
        dashboardMainTab: s.dashboardMainTab,
        savedFolders: s.savedFolders,
        savedTokens: s.savedTokens,
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
        const folderIds = new Set(
          Array.isArray(p.savedFolders)
            ? p.savedFolders
                .map((x) => normalizeSavedFolderRow(x))
                .filter(Boolean)
                .map((f) => (f as SavedFolder).id)
            : [],
        );
        const rawFolders = Array.isArray(p.savedFolders) ? p.savedFolders : [];
        const savedFolders = rawFolders
          .map((x) => normalizeSavedFolderRow(x))
          .filter(Boolean) as SavedFolder[];
        const rawToks = Array.isArray(p.savedTokens) ? p.savedTokens : [];
        let savedTokens = rawToks
          .map((x) => normalizeSavedTokenRow(x))
          .filter(Boolean) as SavedTokenEntry[];
        savedTokens = savedTokens.map((t) =>
          t.folderId !== null && !folderIds.has(t.folderId)
            ? { ...t, folderId: null }
            : t,
        );
        const seen = new Set<string>();
        savedTokens = savedTokens.filter((t) => {
          if (seen.has(t.base)) return false;
          seen.add(t.base);
          return true;
        });
        const tab =
          p.dashboardMainTab === "saved" ? "saved" : ("all" as DashboardMainTab);

        return {
          ...current,
          ...p,
          columnOrder,
          columnVisibility: vis,
          hiddenTokens: Array.isArray(p.hiddenTokens) ? p.hiddenTokens : [],
          dashboardMainTab: tab,
          savedFolders,
          savedTokens: compactTokenOrders(savedTokens),
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
