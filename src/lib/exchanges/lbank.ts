import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type LbankMarketRow = {
  symbol: string;
  baseCurrency?: string;
  clearCurrency?: string;
  fundingRate?: string | number;
  lastPrice?: string | number;
};

type LbankMarketDataResp = {
  success: boolean;
  error_code: number;
  msg: string;
  data: LbankMarketRow[];
};

type LbankFundRateRow = {
  instrumentID: string;
  fundingTime: number;
  fundingRate: string;
  fundingIntervalHours?: number;
};

type LbankFundRateResp = {
  code: number;
  data: {
    totalCount: number;
    totalPages: number;
    hasNext: boolean;
    resultList: LbankFundRateRow[];
  };
};

const LBANK_FUND_RATE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=UTF-8",
  versionFlage: "true",
  source: "4",
  businessVersionCode: "202",
};

export const lbankAdapter: ExchangeFundingAdapter = {
  slug: "lbank" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const url =
      "https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU&productType=PERPETUAL";
    const res = await fetchWithRetry(
      () => fetchJson<LbankMarketDataResp>(url),
      { retries: 2, baseDelayMs: 400 },
    );
    if (!res.success || res.error_code !== 0) {
      throw new Error(`LBank marketData: ${res.msg}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.data ?? []) {
      if (!row.symbol?.endsWith("USDT")) continue;
      if (row.clearCurrency && row.clearCurrency !== "USDT") continue;
      if (row.fundingRate === undefined || row.fundingRate === null) continue;

      const base = (row.baseCurrency ?? row.symbol.replace(/USDT$/i, "")).toUpperCase();
      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      const lp = row.lastPrice != null ? String(row.lastPrice) : undefined;
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(row.fundingRate),
        nextFundingTime: null,
        bestBid: lp,
        bestAsk: lp,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    const startTime = range.since.getTime();
    const endTime = range.until.getTime();

    for (let pageNo = 1; pageNo <= 50; pageNo++) {
      const params = new URLSearchParams({
        ProductGroup: "SwapU",
        instrumentID: nativeSymbol,
        startTime: String(startTime),
        endTime: String(endTime),
        pageSize: "100",
        pageNo: String(pageNo),
      });

      const url = `https://lbkperp.lbank.com/cfd/instrment/v1/fundRateList?${params}`;
      const res = await fetchWithRetry(
        () =>
          fetchJson<LbankFundRateResp>(url, {
            headers: {
              ...LBANK_FUND_RATE_HEADERS,
              "ex-timestamp": String(Date.now()),
            },
          }),
        { retries: 2, baseDelayMs: 500 },
      );

      if (res.code !== 200 || !res.data?.resultList?.length) break;

      for (const row of res.data.resultList) {
        const ts = row.fundingTime * 1000;
        if (ts >= startTime && ts <= endTime) {
          const decimal = Number(row.fundingRate) / 100;
          out.push({
            nativeSymbol: row.instrumentID,
            fundingTime: new Date(ts),
            rate: String(decimal),
          });
        }
      }

      if (!res.data.hasNext) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = {
      5: "minute5",
      30: "minute30",
      60: "hour1",
      240: "hour4",
    };
    const typeStr = intervalMap[intervalMin] ?? "hour4";

    const spotSymbol = nativeSymbol.replace(/USDT$/i, "").toLowerCase() + "_usdt";
    const since = range.since.getTime();
    const until = range.until.getTime();

    const out: KlinePoint[] = [];
    const maxSize = 2000;
    let timeCursor = Math.floor(since / 1000);
    const timeEnd = Math.floor(until / 1000);

    for (let page = 0; page < 30; page++) {
      const url = `https://api.lbkex.com/v2/kline.do?symbol=${spotSymbol}&type=${typeStr}&size=${maxSize}&time=${timeCursor}`;
      const res = await fetchWithRetry(
        () => fetchJson<{ result: string; data: number[][]; error_code: number }>(url),
        { retries: 2, baseDelayMs: 500 },
      );

      if (res.result !== "true" || !Array.isArray(res.data) || res.data.length === 0) break;

      for (const row of res.data) {
        const t = row[0] * 1000;
        if (t >= since && t <= until) {
          out.push({
            time: t,
            open: row[1],
            high: row[2],
            low: row[3],
            close: row[4],
          });
        }
      }

      const maxT = Math.max(...res.data.map((r) => r[0]));
      if (maxT >= timeEnd) break;
      if (res.data.length < maxSize) break;
      timeCursor = maxT + 1;
    }
    return out;
  },
};
