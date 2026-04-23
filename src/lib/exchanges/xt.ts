import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type XtContract = {
  symbol: string;
  ticker_id?: string;
  base_currency: string;
  target_currency: string;
  product_type: string;
  funding_rate?: string;
  next_funding_rate_timestamp?: number;
  mark_price?: string;
  bid?: string;
  ask?: string;
};

type XtContractsResp = XtContract[];

type XtFundingRecordResp = {
  returnCode: number;
  msgInfo: string;
  result?: {
    hasNext: boolean;
    items: {
      symbol: string;
      fundingRate: string;
      createdTime: number;
      id: string;
    }[];
  };
};

export const xtAdapter: ExchangeFundingAdapter = {
  slug: "xt" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const rows = await fetchWithRetry(
      () =>
        fetchJson<XtContractsResp>(
          "https://fapi.xt.com/future/market/v1/public/cg/contracts",
        ),
      { retries: 2, baseDelayMs: 400 },
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      if (row.product_type !== "PERPETUAL") continue;
      if (row.target_currency?.toUpperCase() !== "USDT") continue;
      if (row.funding_rate === undefined) continue;

      const base = row.base_currency.toUpperCase();
      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(row.funding_rate),
        nextFundingTime: row.next_funding_rate_timestamp
          ? new Date(row.next_funding_rate_timestamp)
          : null,
        markPrice: row.mark_price,
        bestBid: row.bid,
        bestAsk: row.ask,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    const since = range.since.getTime();
    const until = range.until.getTime();

    let cursorId: string | undefined = undefined;

    for (let page = 0; page < 2000; page++) {
      const url = new URL(
        "https://fapi.xt.com/future/market/v1/public/q/funding-rate-record",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("limit", "100");
      if (cursorId) url.searchParams.set("id", cursorId);

      const res = await fetchWithRetry(
        () => fetchJson<XtFundingRecordResp>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (res.returnCode !== 0) {
        throw new Error(`XT funding history: ${res.msgInfo}`);
      }
      const items = res.result?.items ?? [];
      if (items.length === 0) break;

      let minTime = Infinity;
      for (const it of items) {
        const t = it.createdTime;
        minTime = Math.min(minTime, t);
        if (t >= since && t <= until) {
          out.push({
            nativeSymbol: it.symbol,
            fundingTime: new Date(t),
            rate: it.fundingRate,
          });
        }
      }

      const last = items[items.length - 1];
      cursorId = last?.id;
      if (!res.result?.hasNext) break;
      if (minTime < since) break;
      if (!cursorId) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = {
      5: "5m",
      30: "30m",
      60: "1h",
      240: "4h",
      480: "8h",
    };
    const interval = intervalMap[intervalMin] ?? "4h";
    const startTime = range.since.getTime();
    const endTime = range.until.getTime();

    const out: KlinePoint[] = [];
    let cursor = startTime;

    for (let page = 0; page < 50; page++) {
      const url = new URL(
        "https://fapi.xt.com/future/market/v1/public/q/kline",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(endTime));
      url.searchParams.set("limit", "500");

      const res = await fetchWithRetry(
        () =>
          fetchJson<{
            returnCode: number;
            result: { t: number; o: string; c: string; h: string; l: string }[];
          }>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (res.returnCode !== 0 || !Array.isArray(res.result)) break;
      if (res.result.length === 0) break;

      for (const row of res.result) {
        out.push({
          time: row.t,
          open: Number(row.o),
          high: Number(row.h),
          low: Number(row.l),
          close: Number(row.c),
        });
      }

      if (res.result.length < 500) break;
      const maxT = Math.max(...res.result.map((r) => r.t));
      cursor = maxT + 1;
      if (cursor >= endTime) break;
    }
    return out;
  },
};
