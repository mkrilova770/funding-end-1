import type { PrismaClient } from "@prisma/client";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";

export type FundingPeriod = "now" | "week" | "month";

export type FundingTableSortKey = "coins" | "maxSpread" | ExchangeAdapterSlug;

export type FundingTableSortDir = "asc" | "desc";

export function normalizeFundingTableSortKey(
  raw: string | null | undefined,
): FundingTableSortKey {
  if (raw === "coins" || raw === "maxSpread") return raw;
  if (raw && ALL_EXCHANGE_SLUGS.includes(raw as ExchangeAdapterSlug)) {
    return raw as ExchangeAdapterSlug;
  }
  return "maxSpread";
}

export function normalizeFundingTableSortDir(
  raw: string | null | undefined,
  sortBy: FundingTableSortKey,
): FundingTableSortDir {
  if (raw === "asc" || raw === "desc") return raw;
  return sortBy === "coins" ? "asc" : "desc";
}

/**
 * Сортировка строк таблицы: монета (A–Z), макс. спред или ставка конкретной биржи.
 * Пустые / нечисловые значения уходят в конец; при равенстве — по тикеру.
 */
export function sortFundingTableRows(
  rows: FundingTableRow[],
  sortBy: FundingTableSortKey,
  sortDir: FundingTableSortDir,
): FundingTableRow[] {
  return [...rows].sort((a, b) => {
    if (sortBy === "coins") {
      const c = a.baseAsset.localeCompare(b.baseAsset);
      return sortDir === "asc" ? c : -c;
    }

    const av =
      sortBy === "maxSpread"
        ? a.maxSpread
        : (a.ratesByExchange[sortBy] ?? null);
    const bv =
      sortBy === "maxSpread"
        ? b.maxSpread
        : (b.ratesByExchange[sortBy] ?? null);

    const aNull = av === null || av === undefined || !Number.isFinite(av);
    const bNull = bv === null || bv === undefined || !Number.isFinite(bv);
    let primary = 0;
    if (aNull && bNull) primary = 0;
    else if (aNull) primary = 1;
    else if (bNull) primary = -1;
    else {
      const diff = av - bv;
      primary = diff === 0 ? 0 : sortDir === "asc" ? (diff < 0 ? -1 : 1) : diff < 0 ? 1 : -1;
    }

    if (primary !== 0) return primary;
    return a.baseAsset.localeCompare(b.baseAsset);
  });
}

export type FundingTableRow = {
  baseAsset: string;
  /** Доля (не проценты): 0.0001 = 0.01%) */
  maxSpread: number | null;
  /** До двух бирж: одна с макс. ставкой, одна с мин. (при ничьей — первая по порядку колонок). */
  maxSpreadSlugs: ExchangeAdapterSlug[];
  ratesByExchange: Partial<Record<ExchangeAdapterSlug, number | null>>;
};

export type FundingTableResult = {
  updatedAt: string | null;
  total: number;
  page: number;
  pageSize: number;
  rows: FundingTableRow[];
  /** Для подсказок в UI: пустая БД vs нет синка vs фильтр поиска */
  meta: {
    exchangeCount: number;
    marketCount: number;
    /** Данные собраны напрямую с бирж (без БД), только для режима «Сейчас». */
    live?: boolean;
    /** Нет БД — недоступны суммы за неделю/месяц. */
    needsHistoryDb?: boolean;
  };
};

function periodToSince(period: FundingPeriod): Date | null {
  if (period === "now") return null;
  const days = period === "week" ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function toNumber(rate: unknown): number {
  if (typeof rate === "number") return rate;
  if (typeof rate === "string") return Number(rate);
  // Prisma.Decimal
  return Number(rate as never);
}

/**
 * Макс. спред по видимым биржам и ровно две биржи для подсветки: одна с макс. ставкой, одна с мин.
 * При ничьей на экстремуме берётся первая по порядку колонок в `visible`.
 */
export function computeSpreadMeta(
  rates: Partial<Record<ExchangeAdapterSlug, number | null>>,
  visible: ExchangeAdapterSlug[],
): { maxSpread: number | null; maxSpreadSlugs: ExchangeAdapterSlug[] } {
  const entries: { slug: ExchangeAdapterSlug; v: number }[] = [];
  for (const slug of visible) {
    const v = rates[slug];
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v)) continue;
    entries.push({ slug, v });
  }
  if (entries.length < 2) {
    return { maxSpread: null, maxSpreadSlugs: [] };
  }
  const values = entries.map((e) => e.v);
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const maxSpread = hi - lo;
  if (maxSpread <= 0) {
    return { maxSpread: 0, maxSpreadSlugs: [] };
  }
  let hiSlug: ExchangeAdapterSlug | null = null;
  let loSlug: ExchangeAdapterSlug | null = null;
  for (const slug of visible) {
    const v = rates[slug];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v === hi && hiSlug === null) hiSlug = slug;
    if (v === lo && loSlug === null) loSlug = slug;
    if (hiSlug !== null && loSlug !== null) break;
  }
  const maxSpreadSlugs: ExchangeAdapterSlug[] = [];
  if (hiSlug !== null) maxSpreadSlugs.push(hiSlug);
  if (loSlug !== null && loSlug !== hiSlug) maxSpreadSlugs.push(loSlug);
  return { maxSpread, maxSpreadSlugs };
}

export async function getFundingTable(
  client: PrismaClient,
  opts: {
    period: FundingPeriod;
    q?: string;
    page: number;
    pageSize: number;
    visibleExchanges: ExchangeAdapterSlug[];
    sortBy: FundingTableSortKey;
    sortDir: FundingTableSortDir;
  },
): Promise<FundingTableResult> {
  const visible = opts.visibleExchanges;
  const since = periodToSince(opts.period);

  const distinctBases = await client.market.findMany({
    where: { exchange: { slug: { in: visible } } },
    distinct: ["baseAsset"],
    select: { baseAsset: true },
  });

  let bases = distinctBases.map((b) => b.baseAsset);
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    bases = bases.filter((b) => b.toLowerCase().includes(q));
  }
  bases.sort((a, b) => a.localeCompare(b));

  const ratesByBase = new Map<
    string,
    Partial<Record<ExchangeAdapterSlug, number | null>>
  >();
  let updatedAtMs = 0;

  for (const b of bases) {
    ratesByBase.set(b, {});
  }

  if (opts.period === "now") {
    const rows = await client.market.findMany({
      where: {
        exchange: { slug: { in: visible } },
        latest: { isNot: null },
      },
      select: {
        baseAsset: true,
        exchange: { select: { slug: true } },
        latest: {
          select: { rate: true, fetchedAt: true, updatedAt: true },
        },
      },
    });

    const pick = new Map<string, { rate: number; ts: number }>();

    for (const r of rows) {
      if (!r.latest) continue;
      const slug = r.exchange.slug as ExchangeAdapterSlug;
      const key = `${slug}::${r.baseAsset}`;
      const ts = Math.max(
        r.latest.fetchedAt.getTime(),
        r.latest.updatedAt.getTime(),
      );
      const rate = toNumber(r.latest.rate);
      const prev = pick.get(key);
      if (!prev || ts >= prev.ts) pick.set(key, { rate, ts });
      updatedAtMs = Math.max(updatedAtMs, ts);
    }

    for (const [key, v] of pick) {
      const [slug, base] = key.split("::") as [ExchangeAdapterSlug, string];
      const row = ratesByBase.get(base);
      if (!row) continue;
      row[slug] = v.rate;
    }
  } else if (since) {
    const grouped = await client.fundingHistoryPoint.groupBy({
      by: ["marketId"],
      where: {
        fundingTime: { gte: since },
        market: { exchange: { slug: { in: visible } } },
      },
      _sum: { rate: true },
    });

    const marketIds = grouped.map((g) => g.marketId);
    const markets =
      marketIds.length === 0
        ? []
        : await client.market.findMany({
            where: { id: { in: marketIds } },
            select: {
              id: true,
              baseAsset: true,
              exchange: { select: { slug: true } },
            },
          });
    const marketById = new Map(markets.map((m) => [m.id, m]));

    for (const g of grouped) {
      const m = marketById.get(g.marketId);
      if (!m) continue;
      const base = m.baseAsset;
      const slug = m.exchange.slug as ExchangeAdapterSlug;
      const map = ratesByBase.get(base);
      if (!map) continue;
      const sum = g._sum.rate;
      map[slug] = sum === null || sum === undefined ? null : toNumber(sum);
    }

    const updated = await client.fundingLatest.findFirst({
      where: { market: { exchange: { slug: { in: visible } } } },
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true },
    });
    updatedAtMs = updated?.fetchedAt.getTime() ?? 0;
  }

  const built: FundingTableRow[] = bases.map((base) => {
    const rates = ratesByBase.get(base) ?? {};
    const { maxSpread, maxSpreadSlugs } = computeSpreadMeta(rates, visible);
    return { baseAsset: base, maxSpread, maxSpreadSlugs, ratesByExchange: rates };
  });

  const sorted = sortFundingTableRows(built, opts.sortBy, opts.sortDir);

  const page = Math.max(1, opts.page);
  const pageSize = Math.min(200, Math.max(5, opts.pageSize));
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const rows = sorted.slice(start, start + pageSize);

  const [exchangeCount, marketCount] = await Promise.all([
    client.exchange.count(),
    client.market.count(),
  ]);

  return {
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    total,
    page,
    pageSize,
    rows,
    meta: { exchangeCount, marketCount },
  };
}
