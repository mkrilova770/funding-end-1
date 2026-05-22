import { EXCHANGE_ADAPTERS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { prisma } from "@/lib/db/prisma";
import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import { getCachedNativeSymbol } from "@/lib/services/funding-table-live";
import { normalizeMergeBase } from "@/lib/services/funding-table";

export type FundingHistorySeriesPoint = {
  fundingTime: string;
  rate: string;
};

export type FundingHistorySeriesResult = {
  exchange: ExchangeAdapterSlug;
  baseAsset: string;
  nativeSymbol: string;
  days: number;
  source: "live" | "db";
  supportsHistory: boolean;
  points: FundingHistorySeriesPoint[];
};

export function clampHistoryDays(raw: number | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function loadFundingHistoryFromDb(opts: {
  exchange: ExchangeAdapterSlug;
  baseAsset: string;
  since: Date;
  until: Date;
}): Promise<FundingHistorySeriesPoint[]> {
  const base = normalizeMergeBase(opts.baseAsset);
  let market = await prisma.market.findFirst({
    where: {
      active: true,
      baseAsset: base,
      exchange: { slug: opts.exchange },
    },
    select: { id: true },
  });
  if (!market) {
    const rows = await prisma.market.findMany({
      where: { active: true, exchange: { slug: opts.exchange } },
      select: { id: true, baseAsset: true },
    });
    market =
      rows.find((r) => normalizeMergeBase(r.baseAsset) === base) ?? null;
  }
  if (!market) return [];

  const rows = await prisma.fundingHistoryPoint.findMany({
    where: {
      marketId: market.id,
      fundingTime: { gte: opts.since, lte: opts.until },
    },
    orderBy: { fundingTime: "desc" },
    select: { fundingTime: true, rate: true },
  });

  return rows.map((r) => ({
    fundingTime: r.fundingTime.toISOString(),
    rate: String(r.rate),
  }));
}

async function resolveNativeSymbolFromDb(
  exchange: ExchangeAdapterSlug,
  base: string,
): Promise<string | null> {
  const b = normalizeMergeBase(base);
  const baseCandidates =
    b === "BTC" ? (["BTC", "XBT"] as const) : ([b] as const);
  const exact = await prisma.market.findFirst({
    where: {
      active: true,
      exchange: { slug: exchange },
      baseAsset: { in: [...baseCandidates] },
    },
    select: { nativeSymbol: true },
  });
  if (exact?.nativeSymbol) return exact.nativeSymbol;

  const rows = await prisma.market.findMany({
    where: { active: true, exchange: { slug: exchange } },
    select: { baseAsset: true, nativeSymbol: true },
    take: 15_000,
  });
  const hit = rows.find((r) => normalizeMergeBase(r.baseAsset) === b);
  return hit?.nativeSymbol ?? null;
}

/** Bitrue: один публичный список контрактов без N× index/depth (устойчиво к таймауту полного снимка). */
async function resolveBitrueNativeFromContracts(
  base: string,
): Promise<string | null> {
  const b = normalizeMergeBase(base);
  try {
    const raw = await fetchWithRetry(
      () => fetchJson<unknown>("https://fapi.bitrue.com/fapi/v1/contracts"),
      { retries: 2, baseDelayMs: 400 },
    );
    const contracts = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: { symbol?: string; multiplierCoin?: string }[] })
            .data
        : null;
    if (!Array.isArray(contracts)) return null;
    for (const c of contracts) {
      if (!c.symbol?.endsWith("-USDT")) continue;
      const coin = c.multiplierCoin?.toUpperCase();
      const ab =
        coin ||
        c.symbol.replace(/^E-/i, "").replace(/-USDT$/i, "").toUpperCase();
      if (!ab) continue;
      if (normalizeMergeBase(ab) === b) return c.symbol;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveNativeSymbol(
  exchange: ExchangeAdapterSlug,
  base: string,
): Promise<string | null> {
  const b = normalizeMergeBase(base);
  const cached = getCachedNativeSymbol(exchange, b);
  if (cached) return cached;

  /* Bitrue: один запрос contracts — до тяжёлого снимка (сотни index), иначе часто таймаут. */
  if (exchange === "bitrue") {
    const lite = await resolveBitrueNativeFromContracts(b);
    if (lite) return lite;
  }

  /** БД быстрее полного снимка биржи — окно истории не должно ждать fetchMarketsWithLatest. */
  const fromDb = await resolveNativeSymbolFromDb(exchange, b);
  if (fromDb) return fromDb;

  const adapter = EXCHANGE_ADAPTERS[exchange];
  try {
    const heavyMs =
      exchange === "bitrue"
        ? 130_000
        : exchange === "tapbit"
          ? 95_000
          : 40_000;
    const snap = await withTimeout(adapter.fetchMarketsWithLatest(), heavyMs);
    const m = snap.markets.find(
      (mk) => normalizeMergeBase(mk.baseAsset) === b,
    );
    if (m?.nativeSymbol) return m.nativeSymbol;
  } catch {
    /* полный снимок мог упасть по таймауту */
  }

  return null;
}

export async function getFundingHistorySeries(opts: {
  exchange: ExchangeAdapterSlug;
  baseAsset: string;
  days: number;
}): Promise<FundingHistorySeriesResult> {
  const base = normalizeMergeBase(opts.baseAsset);
  const days = clampHistoryDays(opts.days);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  const adapter = EXCHANGE_ADAPTERS[opts.exchange];
  const historySupported = adapter.supportsHistory !== false;

  const nativeSymbol = await resolveNativeSymbol(opts.exchange, base);
  if (!nativeSymbol) {
    throw new Error("MARKET_NOT_FOUND");
  }

  if (!historySupported) {
    return {
      exchange: opts.exchange,
      baseAsset: base,
      nativeSymbol,
      days,
      source: "live",
      supportsHistory: false,
      points: [],
    };
  }

  const raw = await withTimeout(
    adapter.fetchFundingHistory(nativeSymbol, { since, until }),
    45_000,
  );
  raw.sort((a, b) => b.fundingTime.getTime() - a.fundingTime.getTime());

  let points: FundingHistorySeriesPoint[] = raw.map((p) => ({
    fundingTime: p.fundingTime.toISOString(),
    rate: p.rate,
  }));
  let source: "live" | "db" = "live";

  if (points.length === 0) {
    const dbPts = await loadFundingHistoryFromDb({
      exchange: opts.exchange,
      baseAsset: base,
      since,
      until,
    });
    if (dbPts.length > 0) {
      points = dbPts;
      source = "db";
    }
  }

  return {
    exchange: opts.exchange,
    baseAsset: base,
    nativeSymbol,
    days,
    source,
    supportsHistory: true,
    points,
  };
}
