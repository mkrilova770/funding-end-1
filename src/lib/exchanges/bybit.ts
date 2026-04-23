import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type BybitTicker = {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markPrice?: string;
  bid1Price?: string;
  ask1Price?: string;
};

type BybitTickersResp = {
  retCode: number;
  retMsg: string;
  result: { category: string; list: BybitTicker[]; nextPageCursor?: string };
};

type BybitFundingHistoryResp = {
  retCode: number;
  retMsg: string;
  result: {
    category: string;
    list: {
      symbol: string;
      fundingRate: string;
      fundingRateTimestamp: string;
    }[];
  };
};

function baseFromLinearUsdt(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  return base ? base.toUpperCase() : null;
}

async function fetchAllLinearUsdtTickers(): Promise<BybitTicker[]> {
  const all: BybitTicker[] = [];
  let cursor: string | undefined = undefined;

  for (let page = 0; page < 50; page++) {
    const url = new URL("https://api.bybit.com/v5/market/tickers");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await fetchWithRetry(
      () => fetchJson<BybitTickersResp>(url.toString()),
      { retries: 2, baseDelayMs: 400 },
    );
    if (data.retCode !== 0) {
      throw new Error(`Bybit tickers: ${data.retMsg}`);
    }
    const list = data.result.list ?? [];
    for (const t of list) {
      if (t.symbol.endsWith("USDT") && !t.symbol.includes("-")) {
        all.push(t);
      }
    }
    cursor = data.result.nextPageCursor;
    if (!cursor || list.length === 0) break;
  }

  return all;
}

export const bybitAdapter: ExchangeFundingAdapter = {
  slug: "bybit" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const tickers = await fetchAllLinearUsdtTickers();
    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const t of tickers) {
      const base = baseFromLinearUsdt(t.symbol);
      if (!base) continue;
      if (t.fundingRate === undefined) continue;
      markets.push({
        nativeSymbol: t.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: t.symbol,
        rate: t.fundingRate,
        nextFundingTime: t.nextFundingTime
          ? new Date(Number(t.nextFundingTime))
          : null,
        markPrice: t.markPrice,
        bestBid: t.bid1Price,
        bestAsk: t.ask1Price,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    let endTime = range.until.getTime();
    const start = range.since.getTime();

    for (let i = 0; i < 200; i++) {
      const url = new URL("https://api.bybit.com/v5/market/funding/history");
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("limit", "200");
      url.searchParams.set("endTime", String(endTime));

      const data = await fetchWithRetry(
        () => fetchJson<BybitFundingHistoryResp>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.retCode !== 0) {
        throw new Error(`Bybit funding history: ${data.retMsg}`);
      }
      const list = data.result.list ?? [];
      if (list.length === 0) break;

      for (const row of list) {
        const ft = Number(row.fundingRateTimestamp);
        if (ft < start) {
          return out.filter((p) => p.fundingTime.getTime() >= start);
        }
        out.push({
          nativeSymbol: row.symbol,
          fundingTime: new Date(ft),
          rate: row.fundingRate,
        });
      }

      const oldest = list[list.length - 1];
      const oldestMs = Number(oldest.fundingRateTimestamp);
      if (oldestMs >= endTime) break;
      endTime = oldestMs - 1;
      if (list.length < 200) break;
    }

    return out.filter((p) => p.fundingTime.getTime() >= start);
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const out: KlinePoint[] = [];
    let start = range.since.getTime();
    const end = range.until.getTime();

    while (start < end) {
      const url = new URL("https://api.bybit.com/v5/market/kline");
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("interval", String(intervalMin));
      url.searchParams.set("start", String(start));
      url.searchParams.set("end", String(end));
      url.searchParams.set("limit", "1000");

      const data = await fetchWithRetry(
        () =>
          fetchJson<{
            retCode: number;
            result: { list: string[][] };
          }>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.retCode !== 0) break;
      const list = data.result.list ?? [];
      if (list.length === 0) break;

      for (const r of list) {
        out.push({ time: Number(r[0]), close: Number(r[4]) });
      }

      const times = list.map((r) => Number(r[0]));
      const maxTime = Math.max(...times);
      const nextStart = maxTime + 1;
      if (nextStart <= start) break;
      start = nextStart;
      if (list.length < 1000) break;
    }

    return out.sort((a, b) => a.time - b.time);
  },
};
