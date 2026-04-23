import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type KuCoinResp<T> = { code: string; msg: string; data: T };

type KuCoinContract = {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
  fundingFeeRate?: number | null;
  predictedFundingFeeRate?: number | null;
  nextFundingRateDateTime?: number | null;
  markPrice?: number | null;
};

function normalizeBase(base: string): string {
  if (base === "XBT") return "BTC";
  return base.toUpperCase();
}

export const kucoinAdapter: ExchangeFundingAdapter = {
  slug: "kucoin" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const url = "https://api-futures.kucoin.com/api/v1/contracts/active";
    const res = await fetchWithRetry(
      () =>
        fetchJson<KuCoinResp<KuCoinContract[]>>(url, {
          headers: { "Accept-Language": "en-US" },
          timeoutMs: 20_000,
        }),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== "200000") {
      throw new Error(`KuCoin contracts: ${res.msg}`);
    }

    const usdt = (res.data ?? []).filter(
      (c) => c.quoteCurrency === "USDT" && c.status === "Open",
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const c of usdt) {
      const rate =
        c.fundingFeeRate ??
        c.predictedFundingFeeRate ??
        null;
      if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) {
        continue;
      }

      markets.push({
        nativeSymbol: c.symbol,
        baseAsset: normalizeBase(c.baseCurrency),
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: c.symbol,
        rate: String(rate),
        nextFundingTime:
          c.nextFundingRateDateTime != null
            ? new Date(c.nextFundingRateDateTime)
            : null,
        markPrice: c.markPrice != null ? String(c.markPrice) : undefined,
      });
    }

    try {
      const tickerRes = await fetchWithRetry(
        () =>
          fetchJson<KuCoinResp<{ symbol: string; bestBidPrice: string; bestAskPrice: string }[]>>(
            "https://api-futures.kucoin.com/api/v1/allTickers",
            { headers: { "Accept-Language": "en-US" }, timeoutMs: 15_000 },
          ),
        { retries: 1, baseDelayMs: 300 },
      );
      if (tickerRes.code === "200000" && Array.isArray(tickerRes.data)) {
        const baMap = new Map(
          tickerRes.data.map((r) => [r.symbol, { bid: r.bestBidPrice, ask: r.bestAskPrice }]),
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
    const from = range.since.getTime();
    const to = range.until.getTime();

    const url = new URL(
      "https://api-futures.kucoin.com/api/v1/contract/funding-rates",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));

    const res = await fetchWithRetry(
      () =>
        fetchJson<
          KuCoinResp<{ fundingRate: number | string; timepoint: number }[]>
        >(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== "200000") {
      throw new Error(`KuCoin funding history: ${res.msg}`);
    }

    for (const row of res.data ?? []) {
      out.push({
        nativeSymbol,
        fundingTime: new Date(row.timepoint),
        rate: String(row.fundingRate),
      });
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const granMap: Record<number, number> = { 5: 5, 30: 30, 60: 60, 240: 240, 480: 480 };
    const granularity = granMap[intervalMin] ?? 240;
    const from = range.since.getTime();
    const to = range.until.getTime();

    const out: KlinePoint[] = [];
    const limit = 200;
    let cursor = from;

    for (let page = 0; page < 50; page++) {
      const url = new URL("https://api-futures.kucoin.com/api/v1/kline/query");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("granularity", String(granularity));
      url.searchParams.set("from", String(cursor));
      url.searchParams.set("to", String(to));

      const res = await fetchWithRetry(
        () =>
          fetchJson<KuCoinResp<number[][]>>(url.toString(), {
            headers: { "Accept-Language": "en-US" },
            timeoutMs: 15_000,
          }),
        { retries: 2, baseDelayMs: 500 },
      );
      if (res.code !== "200000" || !Array.isArray(res.data)) break;
      if (res.data.length === 0) break;

      for (const row of res.data) {
        out.push({
          time: row[0],
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
        });
      }

      if (res.data.length < limit) break;
      const maxT = Math.max(...res.data.map((r) => r[0]));
      cursor = maxT + 1;
      if (cursor >= to) break;
    }
    return out;
  },
};
