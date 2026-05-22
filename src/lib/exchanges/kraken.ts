import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type KrakenTicker = {
  symbol: string;
  tag?: string;
  pair?: string;
  fundingRate?: number;
  fundingRatePrediction?: number;
  markPrice?: number;
  bid?: number;
  ask?: number;
  suspended?: boolean;
};

type KrakenTickersResp = {
  result: string;
  tickers: KrakenTicker[];
};

type KrakenHistRateRow = {
  timestamp: string;
  fundingRate: number;
  relativeFundingRate?: number;
};

type KrakenHistFundingResp = {
  result: string;
  rates?: KrakenHistRateRow[];
};

type KrakenCandle = {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
};

type KrakenCandlesResp = {
  candles: KrakenCandle[];
  more_candles: boolean;
};

const KRAKEN_TICKERS = "https://futures.kraken.com/derivatives/api/v3/tickers";
const KRAKEN_HIST_FUNDING =
  "https://futures.kraken.com/derivatives/api/v3/historical-funding-rates";

function krakenChartResolution(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    /** 8h нет в charts v1 — используем 4h как ближайший публичный шаг */
    480: "4h",
  };
  return m[intervalMin] ?? "4h";
}

export const krakenAdapter: ExchangeFundingAdapter = {
  slug: "kraken" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () => fetchJson<KrakenTickersResp>(KRAKEN_TICKERS),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.result !== "success" || !Array.isArray(res.tickers)) {
      throw new Error("Kraken tickers: unexpected response");
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const t of res.tickers) {
      if (t.tag !== "perpetual" || t.suspended) continue;
      if (typeof t.fundingRate !== "number") continue;
      const pair = t.pair ?? "";
      if (!t.symbol?.startsWith("PF_")) continue;
      if (pair === "USDT:USD") continue;
      const parts = pair.split(":");
      if (parts.length !== 2 || parts[1] !== "USD") continue;
      const base = parts[0]!.toUpperCase();
      if (!base) continue;

      markets.push({
        nativeSymbol: t.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      const mp = t.markPrice != null ? String(t.markPrice) : undefined;
      const mark = t.markPrice != null ? Number(t.markPrice) : NaN;
      const absFunding =
        typeof t.fundingRatePrediction === "number"
          ? t.fundingRatePrediction
          : t.fundingRate;
      // Kraken ticker fundingRate is absolute payment value; normalize to relative rate.
      const rate =
        Number.isFinite(mark) && mark > 0
          ? absFunding / mark
          : absFunding;

      let bestBid: string | undefined;
      let bestAsk: string | undefined;
      if (t.bid != null && t.ask != null) {
        const b = Number(t.bid);
        const a = Number(t.ask);
        if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
          bestBid = String(b);
          bestAsk = String(a);
        }
      }

      latest.push({
        nativeSymbol: t.symbol,
        rate: String(rate),
        nextFundingTime: null,
        markPrice: mp,
        bestBid,
        bestAsk,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const url = new URL(KRAKEN_HIST_FUNDING);
    url.searchParams.set("symbol", nativeSymbol);

    const res = await fetchWithRetry(
      () => fetchJson<KrakenHistFundingResp>(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.result !== "success" || !Array.isArray(res.rates)) {
      throw new Error("Kraken historical funding: unexpected response");
    }

    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];

    for (const row of res.rates) {
      const t = Date.parse(row.timestamp);
      if (!Number.isFinite(t) || t < since || t > until) continue;
      const rel = row.relativeFundingRate;
      const rateStr =
        typeof rel === "number" && Number.isFinite(rel)
          ? String(rel)
          : String(row.fundingRate);
      out.push({
        nativeSymbol,
        fundingTime: new Date(t),
        rate: rateStr,
      });
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const resolution = krakenChartResolution(intervalMin);
    const stepSec = intervalMin * 60;
    const startMs = range.since.getTime();
    const endMs = range.until.getTime();
    let fromSec = Math.floor(startMs / 1000);
    const toSec = Math.ceil(endMs / 1000);

    const byTime = new Map<number, KlinePoint>();

    for (let page = 0; page < 250; page++) {
      const url = new URL(
        `https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(nativeSymbol)}/${resolution}`,
      );
      url.searchParams.set("from", String(fromSec));
      url.searchParams.set("to", String(toSec));

      const res = await fetchWithRetry(
        () => fetchJson<KrakenCandlesResp>(url.toString()),
        { retries: 2, baseDelayMs: 450 },
      );

      const candles = res.candles ?? [];
      if (candles.length === 0) break;

      for (const c of candles) {
        if (c.time < startMs || c.time > endMs) continue;
        const cl = Number(c.close);
        if (!Number.isFinite(cl)) continue;
        byTime.set(c.time, {
          time: c.time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: cl,
        });
      }

      if (!res.more_candles) break;

      const last = candles[candles.length - 1]!;
      const nextFrom = Math.floor(last.time / 1000) + stepSec;
      if (nextFrom <= fromSec || nextFrom > toSec) break;
      fromSec = nextFrom;
    }

    return [...byTime.keys()]
      .sort((a, b) => a - b)
      .map((k) => byTime.get(k)!);
  },
};
