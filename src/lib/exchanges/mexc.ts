import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type MexcFundingRow = {
  symbol: string;
  fundingRate: number;
  nextSettleTime?: number;
  timestamp?: number;
  markPrice?: number;
};

type MexcFundingResp = {
  success: boolean;
  code: number;
  data: MexcFundingRow[];
};

type MexcHistoryResp = {
  success: boolean;
  code: number;
  data: {
    pageSize: number;
    totalPage: number;
    currentPage: number;
    resultList: {
      symbol: string;
      fundingRate: number;
      settleTime: number;
    }[];
  };
};

function baseFromSymbol(symbol: string): string | null {
  if (!symbol.endsWith("_USDT")) return null;
  const base = symbol.slice(0, -"_USDT".length);
  return base ? base.toUpperCase() : null;
}

export const mexcAdapter: ExchangeFundingAdapter = {
  slug: "mexc" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<MexcFundingResp>(
          "https://contract.mexc.com/api/v1/contract/funding_rate",
        ),
      { retries: 2, baseDelayMs: 400 },
    );
    if (!res.success || res.code !== 0) {
      throw new Error(`MEXC funding_rate bulk: code ${res.code}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.data ?? []) {
      const base = baseFromSymbol(row.symbol);
      if (!base) continue;
      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(row.fundingRate),
        nextFundingTime: row.nextSettleTime
          ? new Date(row.nextSettleTime)
          : null,
        markPrice: row.markPrice != null ? String(row.markPrice) : undefined,
      });
    }

    try {
      const tickerRes = await fetchWithRetry(
        () =>
          fetchJson<{ success: boolean; data: { symbol: string; bid1: number; ask1: number }[] }>(
            "https://contract.mexc.com/api/v1/contract/ticker",
          ),
        { retries: 1, baseDelayMs: 300 },
      );
      if (tickerRes.success && Array.isArray(tickerRes.data)) {
        const baMap = new Map(
          tickerRes.data.map((r) => [r.symbol, { bid: String(r.bid1), ask: String(r.ask1) }]),
        );
        for (const l of latest) {
          const ba = baMap.get(l.nativeSymbol);
          if (ba) {
            l.bestBid = ba.bid;
            l.bestAsk = ba.ask;
          }
        }
      }
    } catch { /* ticker bid/ask is optional */ }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    const since = range.since.getTime();
    const until = range.until.getTime();

    for (let page = 1; page < 2000; page++) {
      const url = new URL(
        "https://contract.mexc.com/api/v1/contract/funding_rate/history",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("page_num", String(page));
      url.searchParams.set("page_size", "100");

      const res = await fetchWithRetry(
        () => fetchJson<MexcHistoryResp>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (!res.success || res.code !== 0) {
        throw new Error(`MEXC funding history: code ${res.code}`);
      }
      const list = res.data?.resultList ?? [];
      if (list.length === 0) break;

      let oldestInPage = Infinity;
      for (const row of list) {
        const t = row.settleTime;
        oldestInPage = Math.min(oldestInPage, t);
        if (t >= since && t <= until) {
          out.push({
            nativeSymbol: row.symbol,
            fundingTime: new Date(t),
            rate: String(row.fundingRate),
          });
        }
      }

      if (oldestInPage < since) break;
      if (page >= (res.data?.totalPage ?? page)) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = {
      5: "Min5",
      30: "Min30",
      60: "Min60",
      240: "Hour4",
      480: "Hour8",
    };
    const interval = intervalMap[intervalMin] ?? "Hour4";
    const startSec = Math.floor(range.since.getTime() / 1000);
    const endSec = Math.floor(range.until.getTime() / 1000);

    const url = `https://contract.mexc.com/api/v1/contract/kline/${nativeSymbol}?interval=${interval}&start=${startSec}&end=${endSec}`;
    const res = await fetchWithRetry(
      () =>
        fetchJson<{
          success: boolean;
          data: {
            time: number[];
            open: number[];
            close: number[];
            high: number[];
            low: number[];
          };
        }>(url),
      { retries: 2, baseDelayMs: 500 },
    );
    if (!res.success || !res.data?.time) return [];

    const out: KlinePoint[] = [];
    for (let i = 0; i < res.data.time.length; i++) {
      out.push({
        time: res.data.time[i] * 1000,
        open: res.data.open[i],
        high: res.data.high[i],
        low: res.data.low[i],
        close: res.data.close[i],
      });
    }
    return out;
  },
};
