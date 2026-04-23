import { EXCHANGE_ADAPTERS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { getCachedNativeSymbol } from "@/lib/services/funding-table-live";

export type FundingHistorySeriesPoint = {
  fundingTime: string;
  rate: string;
};

export type FundingHistorySeriesResult = {
  exchange: ExchangeAdapterSlug;
  baseAsset: string;
  nativeSymbol: string;
  days: number;
  source: "live";
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

async function resolveNativeSymbol(
  exchange: ExchangeAdapterSlug,
  base: string,
): Promise<string | null> {
  const cached = getCachedNativeSymbol(exchange, base);
  if (cached) return cached;

  const adapter = EXCHANGE_ADAPTERS[exchange];
  try {
    const snap = await withTimeout(adapter.fetchMarketsWithLatest(), 12_000);
    const m = snap.markets.find((mk) => mk.baseAsset.toUpperCase() === base);
    return m?.nativeSymbol ?? null;
  } catch {
    return null;
  }
}

export async function getFundingHistorySeries(opts: {
  exchange: ExchangeAdapterSlug;
  baseAsset: string;
  days: number;
}): Promise<FundingHistorySeriesResult> {
  const base = opts.baseAsset.trim().toUpperCase();
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
    15_000,
  );
  raw.sort((a, b) => b.fundingTime.getTime() - a.fundingTime.getTime());

  return {
    exchange: opts.exchange,
    baseAsset: base,
    nativeSymbol,
    days,
    source: "live",
    supportsHistory: true,
    points: raw.map((p) => ({
      fundingTime: p.fundingTime.toISOString(),
      rate: p.rate,
    })),
  };
}
