import { EXCHANGE_ADAPTERS, ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import {
  sortFundingTableRows,
  type FundingTableRow,
  type FundingTableResult,
  type FundingTableSortDir,
  type FundingTableSortKey,
} from "@/lib/services/funding-table";

function computeMaxSpread(
  rates: Partial<Record<ExchangeAdapterSlug, number | null>>,
  visible: ExchangeAdapterSlug[],
): number | null {
  const vals: number[] = [];
  for (const slug of visible) {
    const v = rates[slug];
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v)) continue;
    vals.push(v);
  }
  if (vals.length < 2) return null;
  return Math.max(...vals) - Math.min(...vals);
}

function toNumber(rate: string): number {
  return Number(rate);
}

const LIVE_CACHE_MS = 45_000;
const PER_EXCHANGE_MS = 12_000;

type CacheEntry = {
  at: number;
  key: string;
  built: FundingTableRow[];
  nativeSymbols: Map<string, string>;
  markPrices: Map<string, number>;
  bidPrices: Map<string, number>;
  askPrices: Map<string, number>;
};
let cache: CacheEntry | null = null;

function cacheKey(
  visible: ExchangeAdapterSlug[],
  q: string | undefined,
): string {
  const vis = [...visible].sort().join(",");
  const qn = (q ?? "").trim().toLowerCase();
  return `${vis}|${qn}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function fetchOne(slug: ExchangeAdapterSlug) {
  const adapter = EXCHANGE_ADAPTERS[slug];
  try {
    const snap = await withTimeout(
      adapter.fetchMarketsWithLatest(),
      PER_EXCHANGE_MS,
    );
    return { slug, snap } as const;
  } catch {
    return null;
  }
}

async function ensureNowCache(
  visible: ExchangeAdapterSlug[],
  q: string | undefined,
): Promise<CacheEntry> {
  const key = cacheKey(visible, q);
  const now = Date.now();

  if (cache && cache.key === key && now - cache.at < LIVE_CACHE_MS) {
    return cache;
  }

  const results = await Promise.all(visible.map((slug) => fetchOne(slug)));

  const ratesByBase = new Map<
    string,
    Partial<Record<ExchangeAdapterSlug, number | null>>
  >();
  const nativeSymbols = new Map<string, string>();
  const markPrices = new Map<string, number>();
  const bidPrices = new Map<string, number>();
  const askPrices = new Map<string, number>();

  for (const r of results) {
    if (!r) continue;
    const { slug, snap } = r;
    const latestByNative = new Map(
      snap.latest.map((l) => [l.nativeSymbol, l]),
    );
    for (const m of snap.markets) {
      const lf = latestByNative.get(m.nativeSymbol);
      if (!lf) continue;
      const base = m.baseAsset.toUpperCase();
      if (!ratesByBase.has(base)) ratesByBase.set(base, {});
      const row = ratesByBase.get(base)!;
      row[slug] = toNumber(lf.rate);
      nativeSymbols.set(`${slug}::${base}`, m.nativeSymbol);
      const key = `${slug}::${base}`;
      if (lf.markPrice) {
        const mp = Number(lf.markPrice);
        if (Number.isFinite(mp) && mp > 0) markPrices.set(key, mp);
      }
      if (lf.bestBid) {
        const b = Number(lf.bestBid);
        if (Number.isFinite(b) && b > 0) bidPrices.set(key, b);
      }
      if (lf.bestAsk) {
        const a = Number(lf.bestAsk);
        if (Number.isFinite(a) && a > 0) askPrices.set(key, a);
      }
    }
  }

  let bases = [...ratesByBase.keys()];
  const qn = (q ?? "").trim().toLowerCase();
  if (qn) bases = bases.filter((b) => b.toLowerCase().includes(qn));
  bases.sort((a, b) => a.localeCompare(b));

  const built = bases.map((base) => {
    const rates = ratesByBase.get(base) ?? {};
    return {
      baseAsset: base,
      maxSpread: computeMaxSpread(rates, visible),
      ratesByExchange: rates,
    };
  });

  const entry: CacheEntry = {
    at: Date.now(),
    key,
    built,
    nativeSymbols,
    markPrices,
    bidPrices,
    askPrices,
  };
  cache = entry;
  return entry;
}

export function getCachedMarkPrice(
  slug: ExchangeAdapterSlug,
  base: string,
): number | null {
  if (!cache) return null;
  return cache.markPrices.get(`${slug}::${base}`) ?? null;
}

export function getCachedNativeSymbol(
  slug: ExchangeAdapterSlug,
  base: string,
): string | null {
  if (!cache) return null;
  return cache.nativeSymbols.get(`${slug}::${base}`) ?? null;
}

export function getCachedBidAsk(
  slug: ExchangeAdapterSlug,
  base: string,
): { bid: number; ask: number } | null {
  if (!cache) return null;
  const key = `${slug}::${base}`;
  const bid = cache.bidPrices.get(key);
  const ask = cache.askPrices.get(key);
  if (bid === undefined || ask === undefined) return null;
  return { bid, ask };
}

/**
 * Таблица «Сейчас» без БД: параллельные запросы к публичным API бирж, слияние по baseAsset.
 */
export async function getLiveFundingTableNow(opts: {
  q?: string;
  page: number;
  pageSize: number;
  visibleExchanges: ExchangeAdapterSlug[];
  sortBy: FundingTableSortKey;
  sortDir: FundingTableSortDir;
}): Promise<FundingTableResult> {
  const visible =
    opts.visibleExchanges.length > 0
      ? opts.visibleExchanges
      : [...ALL_EXCHANGE_SLUGS];

  const cached = await ensureNowCache(visible, opts.q);
  const sorted = sortFundingTableRows(
    cached.built,
    opts.sortBy,
    opts.sortDir,
  );

  const page = Math.max(1, opts.page);
  const pageSize = Math.min(200, Math.max(5, opts.pageSize));
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const rows = sorted.slice(start, start + pageSize);

  return {
    updatedAt: new Date(cached.at).toISOString(),
    total,
    page,
    pageSize,
    rows,
    meta: {
      exchangeCount: visible.length,
      marketCount: total,
      live: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Период (week / month) — live: суммы фандинга за N дней            */
/* ------------------------------------------------------------------ */

const HISTORY_SUM_CACHE_MS = 10 * 60_000;
const historySumCache = new Map<
  string,
  { at: number; sum: number | null }
>();

async function getHistorySum(
  exchange: ExchangeAdapterSlug,
  nativeSymbol: string,
  days: number,
): Promise<number | null> {
  const key = `${days}::${exchange}::${nativeSymbol}`;
  const c = historySumCache.get(key);
  if (c && Date.now() - c.at < HISTORY_SUM_CACHE_MS) return c.sum;

  try {
    const adapter = EXCHANGE_ADAPTERS[exchange];
    if (adapter.supportsHistory === false) return null;

    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
    const points = await withTimeout(
      adapter.fetchFundingHistory(nativeSymbol, { since, until }),
      15_000,
    );
    const sum = points.reduce((acc, p) => acc + Number(p.rate), 0);
    historySumCache.set(key, { at: Date.now(), sum });
    return sum;
  } catch {
    historySumCache.set(key, { at: Date.now(), sum: null });
    return null;
  }
}

async function mapLimited<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/* ---------- period-level full-table cache ---------- */
const PERIOD_FULL_CACHE_MS = 10 * 60_000;
type PeriodFullCacheEntry = {
  at: number;
  key: string;
  built: FundingTableRow[];
};
const periodFullCache = new Map<string, PeriodFullCacheEntry>();

async function ensurePeriodFullCache(
  visible: ExchangeAdapterSlug[],
  q: string | undefined,
  days: number,
): Promise<PeriodFullCacheEntry> {
  const nowCached = await ensureNowCache(visible, q);
  const ck = `period::${days}::${nowCached.key}`;
  const now = Date.now();
  const existing = periodFullCache.get(ck);
  if (existing && now - existing.at < PERIOD_FULL_CACHE_MS) return existing;

  type Task = {
    base: string;
    exchange: ExchangeAdapterSlug;
    nativeSymbol: string;
  };
  const tasks: Task[] = [];

  for (const row of nowCached.built) {
    for (const slug of visible) {
      if (row.ratesByExchange[slug] === null || row.ratesByExchange[slug] === undefined) continue;
      const ns = nowCached.nativeSymbols.get(`${slug}::${row.baseAsset}`);
      if (!ns) continue;
      tasks.push({ base: row.baseAsset, exchange: slug, nativeSymbol: ns });
    }
  }

  const sums = await mapLimited(tasks, 25, async (task) => {
    const sum = await getHistorySum(task.exchange, task.nativeSymbol, days);
    return { ...task, sum };
  });

  const sumsByBase = new Map<string, Partial<Record<ExchangeAdapterSlug, number | null>>>();
  for (const s of sums) {
    if (!sumsByBase.has(s.base)) sumsByBase.set(s.base, {});
    sumsByBase.get(s.base)![s.exchange] = s.sum;
  }

  const built: FundingTableRow[] = nowCached.built.map((row) => {
    const periodRates = sumsByBase.get(row.baseAsset) ?? {};
    return {
      baseAsset: row.baseAsset,
      maxSpread: computeMaxSpread(periodRates, visible),
      ratesByExchange: periodRates,
    };
  });

  const entry: PeriodFullCacheEntry = { at: Date.now(), key: ck, built };
  periodFullCache.set(ck, entry);
  return entry;
}

export async function getLiveFundingTablePeriod(opts: {
  period: "week" | "month";
  q?: string;
  page: number;
  pageSize: number;
  visibleExchanges: ExchangeAdapterSlug[];
  sortBy: FundingTableSortKey;
  sortDir: FundingTableSortDir;
}): Promise<FundingTableResult> {
  const visible =
    opts.visibleExchanges.length > 0
      ? opts.visibleExchanges
      : [...ALL_EXCHANGE_SLUGS];
  const days = opts.period === "week" ? 7 : 30;

  const periodCached = await ensurePeriodFullCache(visible, opts.q, days);

  const sorted = sortFundingTableRows(
    periodCached.built,
    opts.sortBy,
    opts.sortDir,
  );

  const page = Math.max(1, opts.page);
  const pageSize = Math.min(200, Math.max(5, opts.pageSize));
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const rows = sorted.slice(start, start + pageSize);

  return {
    updatedAt: new Date(periodCached.at).toISOString(),
    total,
    page,
    pageSize,
    rows,
    meta: {
      exchangeCount: visible.length,
      marketCount: total,
      live: true,
    },
  };
}
