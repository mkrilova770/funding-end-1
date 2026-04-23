import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type BitgetResp<T> = { code: string; msg: string; data: T };

type BitgetTicker = {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markPrice?: string;
  bidPr?: string;
  askPr?: string;
};

type BitgetHistoryRow = {
  symbol: string;
  fundingRate: string;
  fundingTime: string;
};

function baseFromSymbol(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  return base ? base.toUpperCase() : null;
}

export const bitgetAdapter: ExchangeFundingAdapter = {
  slug: "bitget" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const url =
      "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
    const res = await fetchWithRetry(
      () => fetchJson<BitgetResp<BitgetTicker[]>>(url),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== "00000") {
      throw new Error(`Bitget tickers: ${res.msg}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.data ?? []) {
      const base = baseFromSymbol(row.symbol);
      if (!base) continue;
      if (row.fundingRate === undefined) continue;
      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: row.fundingRate,
        nextFundingTime: row.nextFundingTime
          ? new Date(Number(row.nextFundingTime))
          : null,
        markPrice: row.markPrice,
        bestBid: row.bidPr,
        bestAsk: row.askPr,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    let pageNo = 1;

    for (let i = 0; i < 200; i++) {
      const url = new URL(
        "https://api.bitget.com/api/v2/mix/market/history-fund-rate",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("productType", "USDT-FUTURES");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("pageNo", String(pageNo));

      const res = await fetchWithRetry(
        () => fetchJson<BitgetResp<BitgetHistoryRow[]>>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (res.code !== "00000") {
        throw new Error(`Bitget funding history: ${res.msg}`);
      }
      const list = Array.isArray(res.data) ? res.data : [];
      if (list.length === 0) break;

      for (const row of list) {
        out.push({
          nativeSymbol: row.symbol,
          fundingTime: new Date(Number(row.fundingTime)),
          rate: row.fundingRate,
        });
      }

      pageNo += 1;
      if (list.length < 100) break;
      const oldest = list[list.length - 1];
      if (Number(oldest.fundingTime) < range.since.getTime()) break;
    }

    return out.filter(
      (p) =>
        p.fundingTime.getTime() >= range.since.getTime() &&
        p.fundingTime.getTime() <= range.until.getTime(),
    );
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const granMap: Record<number, string> = { 5: "5m", 30: "30m", 60: "1H", 240: "4H", 480: "8H" };
    const granularity = granMap[intervalMin] ?? "4H";
    const url = new URL(
      "https://api.bitget.com/api/v2/mix/market/candles",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("productType", "USDT-FUTURES");
    url.searchParams.set("granularity", granularity);
    url.searchParams.set("startTime", String(range.since.getTime()));
    url.searchParams.set("endTime", String(range.until.getTime()));
    url.searchParams.set("limit", "1000");

    const res = await fetchWithRetry(
      () => fetchJson<BitgetResp<string[][]>>(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== "00000" || !Array.isArray(res.data)) return [];

    return res.data
      .map((r) => ({ time: Number(r[0]), close: Number(r[4]) }))
      .sort((a, b) => a.time - b.time);
  },
};
