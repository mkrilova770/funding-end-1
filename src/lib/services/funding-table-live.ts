import { EXCHANGE_ADAPTERS, ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import {
  computeSpreadMeta,
  emptyFundingTableRow,
  normalizeMergeBase,
  sortFundingTableRows,
  withPinnedMajorsFirst,
  type FundingTableRow,
  type FundingTableResult,
  type FundingTableSortDir,
  type FundingTableSortKey,
} from "@/lib/services/funding-table";

function toNumber(rate: string): number {
  return Number(rate);
}

/**
 * Вкладка «Сохранённые»: тикер должен отображаться даже если ни одна из видимых
 * бирж не вернула пару в live-снимке (пустые ячейки вместо «пропала строка»).
 */
function mergeMissingBasesFilterRows(
  rows: FundingTableRow[],
  basesFilter: string[] | undefined,
  visible: ExchangeAdapterSlug[],
): FundingTableRow[] {
  if (!basesFilter?.length) return rows;
  const have = new Set(rows.map((r) => r.baseAsset));
  const want = basesFilter
    .map((b) => b.trim().toUpperCase())
    .filter(Boolean);
  const extra: FundingTableRow[] = [];
  for (const b of want) {
    if (!have.has(b)) extra.push(emptyFundingTableRow(b, visible));
  }
  return extra.length === 0 ? rows : [...rows, ...extra];
}

/** Поиск «BTC» при нуле совпадений: одна строка-тикер с пустыми ячейками (видимость тикера). */
function injectSearchPlaceholderIfEmpty(
  rows: FundingTableRow[],
  qRaw: string | undefined,
  visible: ExchangeAdapterSlug[],
): FundingTableRow[] {
  const t = (qRaw ?? "").trim().toUpperCase();
  if (rows.length > 0 || !t) return rows;
  if (!/^[A-Z0-9]{2,32}$/.test(t)) return rows;
  return [emptyFundingTableRow(t, visible)];
}

/** Дольше живёт merge-кэш — меньше полных опросов всех бирж при навигации. */
const LIVE_CACHE_MS = 180_000;
/** Upper bound per exchange for cold-start snapshot. */
const PER_EXCHANGE_MS = 15_000;
/** Bitrue: сотни пар × (index+depth) — без увеличения таймаута снимок не укладывается в лимит. */
const PER_EXCHANGE_MS_BY_SLUG: Partial<Record<ExchangeAdapterSlug, number>> = {
  /** Иначе весь /api/funding/table ждёт одну биржу и упирается в таймаут прокси. */
  bitrue: 22_000,
  /** Tapbit: ticker + funding_rate по каждому контракту с паузой (лимит API ~3/s). */
  tapbit: 22_000,
};
/** Transient 429/503 happens on some adapters; retry before dropping exchange snapshot. */
const PER_EXCHANGE_RETRIES = 0;
const PER_EXCHANGE_RETRY_DELAY_MS = 350;

/**
 * Сбор сумм за период без БД: общий бюджет (под maxDuration хостинга).
 * Раньше 60 с — массовый таймаут и пустые суммы; при DATABASE_URL неделя/месяц идут через Prisma.
 */
const PERIOD_HISTORY_BUDGET_MS = 270_000;
/** Параллельные history-запросы за период (осторожно с 429 на «лёгких» API). */
const PERIOD_HISTORY_CONCURRENCY = 48;
/** Пер-бирежа снимок: чуть дольше используем прошлый успех при сбоях/таймаутах. */
const EXCHANGE_SNAP_TTL_MS = 120_000;

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
const nowCacheInflight = new Map<string, Promise<CacheEntry>>();
type ExchangeSnap = Awaited<
  ReturnType<(typeof EXCHANGE_ADAPTERS)[ExchangeAdapterSlug]["fetchMarketsWithLatest"]>
>;
const exchangeSnapCache = new Map<
  ExchangeAdapterSlug,
  { at: number; snap: ExchangeSnap }
>();

function cacheKey(
  visible: ExchangeAdapterSlug[],
): string {
  const vis = [...visible].sort().join(",");
  return vis;
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
  const cached = exchangeSnapCache.get(slug);
  if (cached && Date.now() - cached.at < EXCHANGE_SNAP_TTL_MS) {
    return { slug, snap: cached.snap } as const;
  }
  const perMs = PER_EXCHANGE_MS_BY_SLUG[slug] ?? PER_EXCHANGE_MS;
  for (let attempt = 0; attempt <= PER_EXCHANGE_RETRIES; attempt++) {
    try {
      const snap = await withTimeout(adapter.fetchMarketsWithLatest(), perMs);
      exchangeSnapCache.set(slug, { at: Date.now(), snap });
      return { slug, snap } as const;
    } catch {
      if (attempt < PER_EXCHANGE_RETRIES) {
        await new Promise((r) => setTimeout(r, PER_EXCHANGE_RETRY_DELAY_MS));
      }
    }
  }
  // On transient API failures, keep table complete with last known snapshot.
  if (cached) return { slug, snap: cached.snap } as const;
  return null;
}

async function ensureNowCache(
  visible: ExchangeAdapterSlug[],
): Promise<CacheEntry> {
  const key = cacheKey(visible);
  const now = Date.now();

  if (cache && cache.key === key && now - cache.at < LIVE_CACHE_MS) {
    return cache;
  }

  const inflight = nowCacheInflight.get(key);
  if (inflight) return inflight;

  const build = (async () => {
    const results = await Promise.all(visible.map((slug) => fetchOne(slug)));

    const ratesByBase = new Map<
      string,
      Partial<Record<ExchangeAdapterSlug, number | null>>
    >();
    const intervalsByBase = new Map<
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
        const base = normalizeMergeBase(m.baseAsset);
        if (!ratesByBase.has(base)) ratesByBase.set(base, {});
        if (!intervalsByBase.has(base)) intervalsByBase.set(base, {});
        const row = ratesByBase.get(base)!;
        const intRow = intervalsByBase.get(base)!;
        const lf = latestByNative.get(m.nativeSymbol);
        const symKey = `${slug}::${base}`;
        if (lf) {
          row[slug] = toNumber(lf.rate);
          if (
            lf.fundingIntervalHours !== undefined &&
            lf.fundingIntervalHours !== null
          ) {
            intRow[slug] = lf.fundingIntervalHours;
          }
          nativeSymbols.set(symKey, m.nativeSymbol);
          if (lf.markPrice) {
            const mp = Number(lf.markPrice);
            if (Number.isFinite(mp) && mp > 0) markPrices.set(symKey, mp);
          }
          if (lf.bestBid) {
            const b = Number(lf.bestBid);
            if (Number.isFinite(b) && b > 0) bidPrices.set(symKey, b);
          }
          if (lf.bestAsk) {
            const a = Number(lf.bestAsk);
            if (Number.isFinite(a) && a > 0) askPrices.set(symKey, a);
          }
        } else {
          /** Рынок есть в списке биржи, но строки funding в latest нет (рассинхрон эндпойнтов) — строка/колонка не пропадают. */
          if (row[slug] === undefined) row[slug] = null;
          if (!nativeSymbols.has(symKey)) {
            nativeSymbols.set(symKey, m.nativeSymbol);
          }
        }
      }
    }

    const bases = [...ratesByBase.keys()];
    bases.sort((a, b) => a.localeCompare(b));

    const built = bases.map((base) => {
      const rates = ratesByBase.get(base) ?? {};
      const fundingIntervalHoursByExchange =
        intervalsByBase.get(base) ?? {};
      const { maxSpread, maxSpreadSlugs } = computeSpreadMeta(rates, visible);
      return {
        baseAsset: base,
        maxSpread,
        maxSpreadSlugs,
        ratesByExchange: rates,
        fundingIntervalHoursByExchange,
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
  })().finally(() => {
    nowCacheInflight.delete(key);
  });

  nowCacheInflight.set(key, build);
  return build;
}

export function getCachedMarkPrice(
  slug: ExchangeAdapterSlug,
  base: string,
): number | null {
  if (!cache) return null;
  const key = `${slug}::${normalizeMergeBase(base)}`;
  return cache.markPrices.get(key) ?? null;
}

export function getCachedNativeSymbol(
  slug: ExchangeAdapterSlug,
  base: string,
): string | null {
  if (!cache) return null;
  const key = `${slug}::${normalizeMergeBase(base)}`;
  return cache.nativeSymbols.get(key) ?? null;
}

export function getCachedBidAsk(
  slug: ExchangeAdapterSlug,
  base: string,
): { bid: number; ask: number } | null {
  if (!cache) return null;
  const key = `${slug}::${normalizeMergeBase(base)}`;
  const bid = cache.bidPrices.get(key);
  const ask = cache.askPrices.get(key);
  if (bid === undefined || ask === undefined) return null;
  return { bid, ask };
}

/** Последняя ставка фандинга из live-снимка (после `getLiveFundingTableNow` / `ensureNowCache`). */
export function getCachedLatestFundingRate(
  slug: ExchangeAdapterSlug,
  base: string,
): number | null {
  if (!cache) return null;
  const b = normalizeMergeBase(base);
  const row = cache.built.find((r) => r.baseAsset === b);
  if (!row) return null;
  const v = row.ratesByExchange[slug];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return v;
}

/**
 * Таблица «Сейчас» без БД: параллельные запросы к публичным API бирж, слияние по baseAsset.
 */
/** Верхняя граница строк в ответе fullList (JSON и память). При превышении оставляем топ по maxSpread. */
const NOW_FULL_LIST_ROW_CAP = 16_000;

export async function getLiveFundingTableNow(opts: {
  q?: string;
  page: number;
  pageSize: number;
  visibleExchanges: ExchangeAdapterSlug[];
  sortBy: FundingTableSortKey;
  sortDir: FundingTableSortDir;
  /** Если задано — только эти baseAsset (после сортировки), для вкладки «Сохранённые». */
  basesFilter?: string[];
  /** Вернуть все подготовленные строки без сортировки и slice — для клиентской сортировки. */
  fullList?: boolean;
}): Promise<FundingTableResult> {
  const visible =
    opts.visibleExchanges.length > 0
      ? opts.visibleExchanges
      : [...ALL_EXCHANGE_SLUGS];

  const cached = await ensureNowCache(visible);
  let rows = mergeMissingBasesFilterRows(
    [...cached.built],
    opts.basesFilter,
    visible,
  );
  const qn = (opts.q ?? "").trim().toLowerCase();
  if (qn) {
    rows = rows.filter((r) => r.baseAsset.toLowerCase().includes(qn));
  }
  rows = injectSearchPlaceholderIfEmpty(rows, opts.q, visible);
  let prepared = withPinnedMajorsFirst(rows, {
    basesFilter: opts.basesFilter,
    q: opts.q,
  });

  if (opts.basesFilter?.length) {
    const want = new Set(
      opts.basesFilter.map((b) => b.trim().toUpperCase()).filter(Boolean),
    );
    prepared = prepared.filter((r) => want.has(r.baseAsset));
  }

  if (opts.fullList) {
    if (prepared.length > NOW_FULL_LIST_ROW_CAP) {
      prepared = sortFundingTableRows(prepared, "maxSpread", "desc").slice(
        0,
        NOW_FULL_LIST_ROW_CAP,
      );
    }
    const total = prepared.length;
    return {
      updatedAt: new Date(cached.at).toISOString(),
      total,
      page: 1,
      pageSize: total,
      rows: prepared,
      meta: {
        exchangeCount: visible.length,
        marketCount: total,
        live: true,
        fullList: true,
      },
    };
  }

  let sorted = sortFundingTableRows(prepared, opts.sortBy, opts.sortDir);

  const pageCap = opts.basesFilter?.length ? 500 : 200;
  const pageSize = Math.min(pageCap, Math.max(5, opts.pageSize));
  const total = sorted.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page), maxPage);
  const start = (page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  return {
    updatedAt: new Date(cached.at).toISOString(),
    total,
    page,
    pageSize,
    rows: pageRows,
    meta: {
      exchangeCount: visible.length,
      marketCount: total,
      live: true,
    },
  };
}

/** Все строки live-таблицы без пагинации (дайджесты, уведомления). */
export async function getLiveFundingTableAllRows(
  visibleExchanges?: ExchangeAdapterSlug[],
): Promise<FundingTableRow[]> {
  const visible =
    visibleExchanges?.length ? visibleExchanges : [...ALL_EXCHANGE_SLUGS];
  const cached = await ensureNowCache(visible);
  const sorted = sortFundingTableRows([...cached.built], "maxSpread", "desc");
  return withPinnedMajorsFirst(sorted, {});
}

/* ------------------------------------------------------------------ */
/*  Период (day / threeDays / week / month) — live: суммы фандинга за N дней */
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
      12_000,
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
const PERIOD_FULL_CACHE_MS = 18 * 60_000;
type PeriodFullCacheEntry = {
  at: number;
  key: string;
  built: FundingTableRow[];
};
const periodFullCache = new Map<string, PeriodFullCacheEntry>();
const periodFullInflight = new Map<string, Promise<PeriodFullCacheEntry>>();

function periodScopeCacheKey(scope?: {
  basesFilter?: string[];
  q?: string;
}): string {
  const parts: string[] = [];
  if (scope?.basesFilter?.length) {
    const b = [
      ...new Set(
        scope.basesFilter.map((x) => x.trim().toUpperCase()).filter(Boolean),
      ),
    ]
      .sort()
      .join(",");
    if (b) parts.push(`b:${b}`);
  }
  const qn = (scope?.q ?? "").trim().toLowerCase();
  if (qn) parts.push(`q:${qn}`);
  return parts.length ? parts.join("|") : "all";
}

async function computePeriodFullCacheEntry(
  nowCached: CacheEntry,
  visible: ExchangeAdapterSlug[],
  days: number,
  ck: string,
  wantBases: Set<string> | null,
  qn: string,
): Promise<PeriodFullCacheEntry> {
  type Task = {
    base: string;
    exchange: ExchangeAdapterSlug;
    nativeSymbol: string;
  };
  const tasks: Task[] = [];

  for (const row of nowCached.built) {
    if (wantBases && !wantBases.has(row.baseAsset)) continue;
    if (qn && !row.baseAsset.toLowerCase().includes(qn)) continue;
    for (const slug of visible) {
      if (row.ratesByExchange[slug] === null || row.ratesByExchange[slug] === undefined) continue;
      const ns = nowCached.nativeSymbols.get(`${slug}::${row.baseAsset}`);
      if (!ns) continue;
      tasks.push({ base: row.baseAsset, exchange: slug, nativeSymbol: ns });
    }
  }

  type SumRow = Task & { sum: number | null };
  let sums: SumRow[];
  try {
    sums = await withTimeout(
      mapLimited(tasks, PERIOD_HISTORY_CONCURRENCY, async (task) => {
        const sum = await getHistorySum(task.exchange, task.nativeSymbol, days);
        return { ...task, sum };
      }),
      PERIOD_HISTORY_BUDGET_MS,
    );
  } catch {
    sums = tasks.map((t) => ({ ...t, sum: null as number | null }));
  }

  const sumsByBase = new Map<string, Partial<Record<ExchangeAdapterSlug, number | null>>>();
  for (const s of sums) {
    if (!sumsByBase.has(s.base)) sumsByBase.set(s.base, {});
    sumsByBase.get(s.base)![s.exchange] = s.sum;
  }

  const built: FundingTableRow[] = nowCached.built.map((row) => {
    const periodRates = sumsByBase.get(row.baseAsset) ?? {};
    const { maxSpread, maxSpreadSlugs } = computeSpreadMeta(
      periodRates,
      visible,
    );
    return {
      baseAsset: row.baseAsset,
      maxSpread,
      maxSpreadSlugs,
      ratesByExchange: periodRates,
      fundingIntervalHoursByExchange: row.fundingIntervalHoursByExchange,
    };
  });

  const entry: PeriodFullCacheEntry = { at: Date.now(), key: ck, built };
  periodFullCache.set(ck, entry);
  return entry;
}

async function ensurePeriodFullCache(
  visible: ExchangeAdapterSlug[],
  days: number,
  scope?: { basesFilter?: string[]; q?: string },
): Promise<PeriodFullCacheEntry> {
  const nowCached = await ensureNowCache(visible);
  const scopeKey = periodScopeCacheKey(scope);
  const ck = `period::${days}::${nowCached.key}::${scopeKey}`;
  const now = Date.now();
  const existing = periodFullCache.get(ck);
  if (existing && now - existing.at < PERIOD_FULL_CACHE_MS) return existing;

  const inflight = periodFullInflight.get(ck);
  if (inflight) return inflight;

  const wantBases =
    scope?.basesFilter?.length
      ? new Set(
          scope.basesFilter.map((x) => x.trim().toUpperCase()).filter(Boolean),
        )
      : null;
  const qn = (scope?.q ?? "").trim().toLowerCase();

  const p = computePeriodFullCacheEntry(
    nowCached,
    visible,
    days,
    ck,
    wantBases,
    qn,
  ).finally(() => {
    periodFullInflight.delete(ck);
  });
  periodFullInflight.set(ck, p);
  return p;
}

export async function getLiveFundingTablePeriod(opts: {
  period: "day" | "threeDays" | "week" | "month";
  q?: string;
  page: number;
  pageSize: number;
  visibleExchanges: ExchangeAdapterSlug[];
  sortBy: FundingTableSortKey;
  sortDir: FundingTableSortDir;
  basesFilter?: string[];
}): Promise<FundingTableResult> {
  const visible =
    opts.visibleExchanges.length > 0
      ? opts.visibleExchanges
      : [...ALL_EXCHANGE_SLUGS];
  const days =
    opts.period === "day"
      ? 1
      : opts.period === "threeDays"
        ? 3
        : opts.period === "week"
          ? 7
          : 30;

  const periodCached = await ensurePeriodFullCache(visible, days, {
    basesFilter: opts.basesFilter,
    q: opts.q,
  });

  let sorted = sortFundingTableRows(
    mergeMissingBasesFilterRows(
      [...periodCached.built],
      opts.basesFilter,
      visible,
    ),
    opts.sortBy,
    opts.sortDir,
  );
  const qn = (opts.q ?? "").trim().toLowerCase();
  if (qn) {
    sorted = sorted.filter((r) => r.baseAsset.toLowerCase().includes(qn));
  }
  sorted = injectSearchPlaceholderIfEmpty(sorted, opts.q, visible);
  sorted = withPinnedMajorsFirst(sorted, {
    basesFilter: opts.basesFilter,
    q: opts.q,
  });

  if (opts.basesFilter?.length) {
    const want = new Set(
      opts.basesFilter.map((b) => b.trim().toUpperCase()).filter(Boolean),
    );
    sorted = sorted.filter((r) => want.has(r.baseAsset));
  }

  const pageCap = opts.basesFilter?.length ? 500 : 200;
  const pageSize = Math.min(pageCap, Math.max(5, opts.pageSize));
  const total = sorted.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page), maxPage);
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
