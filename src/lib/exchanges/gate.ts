import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type GateTicker = {
  contract: string;
  funding_rate?: string;
  funding_rate_indicative?: string;
  funding_interval?: number;
  mark_price?: string;
  highest_bid?: string;
  lowest_ask?: string;
};

function baseFromContract(contract: string): string | null {
  if (!contract.endsWith("_USDT")) return null;
  const base = contract.slice(0, -"_USDT".length);
  return base ? base.toUpperCase() : null;
}

export const gateAdapter: ExchangeFundingAdapter = {
  slug: "gate" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const rows = await fetchWithRetry(
      () =>
        fetchJson<GateTicker[]>(
          "https://api.gateio.ws/api/v4/futures/usdt/tickers",
        ),
      { retries: 2, baseDelayMs: 400 },
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      const base = baseFromContract(row.contract);
      if (!base) continue;
      const rate = row.funding_rate ?? row.funding_rate_indicative;
      if (!rate) continue;
      markets.push({
        nativeSymbol: row.contract,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.contract,
        rate,
        nextFundingTime: null,
        markPrice: row.mark_price,
        bestBid: row.highest_bid,
        bestAsk: row.lowest_ask,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    const limit = 100;
    const sinceS = Math.floor(range.since.getTime() / 1000);
    let toS = Math.floor(range.until.getTime() / 1000);

    for (let page = 0; page < 50; page++) {
      const url = new URL(
        "https://api.gateio.ws/api/v4/futures/usdt/funding_rate",
      );
      url.searchParams.set("contract", nativeSymbol);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("from", String(sinceS));
      url.searchParams.set("to", String(toS));

      const data = await fetchWithRetry(
        () =>
          fetchJson<{ t: number; r: string }[]>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );

      if (!Array.isArray(data) || data.length === 0) break;

      for (const row of data) {
        out.push({
          nativeSymbol,
          fundingTime: new Date(row.t * 1000),
          rate: row.r,
        });
      }

      if (data.length < limit) break;
      const oldestT = Math.min(...data.map((r) => r.t));
      const nextTo = oldestT - 1;
      if (nextTo <= sinceS) break;
      toS = nextTo;
    }

    return out.filter(
      (p) =>
        p.fundingTime.getTime() >= range.since.getTime() &&
        p.fundingTime.getTime() <= range.until.getTime(),
    );
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = { 5: "5m", 30: "30m", 60: "1h", 240: "4h", 480: "8h" };
    const interval = intervalMap[intervalMin] ?? "4h";
    const url = new URL(
      "https://api.gateio.ws/api/v4/futures/usdt/candlesticks",
    );
    url.searchParams.set("contract", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set(
      "from",
      String(Math.floor(range.since.getTime() / 1000)),
    );
    url.searchParams.set(
      "to",
      String(Math.floor(range.until.getTime() / 1000)),
    );

    const rows = await fetchWithRetry(
      () =>
        fetchJson<{ t: number; c: string }[]>(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (!Array.isArray(rows)) return [];

    return rows.map((r) => ({
      time: r.t * 1000,
      close: Number(r.c),
    }));
  },
};
