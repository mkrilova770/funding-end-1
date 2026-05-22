import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import { normalizeStandardFundingIntervalHours } from "@/lib/formatters/funding";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type ZxRow = {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markPrice?: string;
  bid1Price?: string;
  ask1Price?: string;
  fundingIntervalHour?: string | number;
};

type ZxResp = {
  retCode: number;
  retMsg?: string;
  result?: { list?: ZxRow[] };
};

type ZxFundHistResp = {
  retCode: number;
  retMsg?: string;
  result?: {
    category?: string;
    list?: { symbol: string; fundingRate: string; fundingRateTimestamp: string }[];
  };
};

function zoomexInterval(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5",
    30: "30",
    60: "60",
    240: "240",
    480: "480",
  };
  return m[intervalMin] ?? "240";
}

export const zoomexAdapter: ExchangeFundingAdapter = {
  slug: "zoomex" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<ZxResp>(
          "https://openapi.zoomex.com/cloud/trade/v3/market/tickers?category=linear",
        ),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.retCode !== 0 || !Array.isArray(res.result?.list)) {
      throw new Error(`Zoomex tickers: ${res.retMsg ?? res.retCode}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.result.list!) {
      if (!row.symbol?.endsWith("USDT")) continue;
      if (row.fundingRate === undefined || row.fundingRate === "") continue;
      const base = row.symbol.replace(/USDT$/i, "").toUpperCase();
      if (!base) continue;

      const nextMs = row.nextFundingTime ? Number(row.nextFundingTime) : NaN;
      const mp = row.markPrice != null ? String(row.markPrice) : undefined;
      const bid = row.bid1Price != null ? String(row.bid1Price) : mp;
      const ask = row.ask1Price != null ? String(row.ask1Price) : mp;

      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(row.fundingRate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: mp,
        bestBid: bid,
        bestAsk: ask,
        fundingIntervalHours: normalizeStandardFundingIntervalHours(
          row.fundingIntervalHour === undefined ||
            row.fundingIntervalHour === null ||
            row.fundingIntervalHour === ""
            ? undefined
            : Number(row.fundingIntervalHour),
        ),
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];
    let endTime = until;

    for (let i = 0; i < 200; i++) {
      const url = new URL(
        "https://openapi.zoomex.com/cloud/trade/v3/market/funding/history",
      );
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("limit", "200");
      url.searchParams.set("endTime", String(endTime));

      const res = await fetchWithRetry(
        () => fetchJson<ZxFundHistResp>(url.toString()),
        { retries: 2, baseDelayMs: 400 },
      );
      if (res.retCode !== 0 || !Array.isArray(res.result?.list)) break;

      const list = res.result!.list!;
      if (list.length === 0) break;

      for (const row of list) {
        const t = Number(row.fundingRateTimestamp);
        if (!Number.isFinite(t)) continue;
        if (t < since) {
          return out
            .filter((p) => p.fundingTime.getTime() >= since)
            .sort(
              (a, b) => a.fundingTime.getTime() - b.fundingTime.getTime(),
            );
        }
        if (t > until) continue;
        out.push({
          nativeSymbol: row.symbol ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.fundingRate),
        });
      }

      const oldest = list[list.length - 1];
      const oldestMs = Number(oldest.fundingRateTimestamp);
      if (!Number.isFinite(oldestMs) || oldestMs >= endTime) break;
      endTime = oldestMs - 1;
      if (list.length < 200) break;
    }

    return out
      .filter((p) => p.fundingTime.getTime() >= since)
      .sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const interval = zoomexInterval(intervalMin);
    const url = new URL(
      "https://openapi.zoomex.com/cloud/trade/v3/market/kline",
    );
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("start", String(range.since.getTime()));
    url.searchParams.set("end", String(range.until.getTime()));

    const res = await fetchWithRetry(
      () =>
        fetchJson<{
          retCode: number;
          retMsg?: string;
          result?: { list?: string[][] };
        }>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (res.retCode !== 0 || !Array.isArray(res.result?.list)) return [];

    const out: KlinePoint[] = [];
    for (const row of res.result!.list!) {
      const t = Number(row[0]);
      if (!Number.isFinite(t)) continue;
      const o = Number(row[1]);
      const h = Number(row[2]);
      const l = Number(row[3]);
      const c = Number(row[4]);
      if (!Number.isFinite(c)) continue;
      out.push({
        time: t,
        open: Number.isFinite(o) ? o : undefined,
        high: Number.isFinite(h) ? h : undefined,
        low: Number.isFinite(l) ? l : undefined,
        close: c,
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },
};
