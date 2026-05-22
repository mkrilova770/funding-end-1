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

type BitmartSym = {
  symbol: string;
  product_type: number;
  base_currency: string;
  quote_currency: string;
  funding_rate?: string;
  funding_time?: number;
  last_price?: string;
  status?: string;
  funding_interval_hours?: number;
};

type BitmartDetailsResp = {
  code: number;
  message?: string;
  data?: { symbols?: BitmartSym[] };
};

type BitmartHistRow = {
  symbol: string;
  funding_rate: string;
  funding_time: string;
};

function bitmartStepMinutes(intervalMin: number): number {
  const m: Record<number, number> = {
    5: 5,
    30: 30,
    60: 60,
    240: 240,
    480: 480,
  };
  return m[intervalMin] ?? 240;
}

export const bitmartAdapter: ExchangeFundingAdapter = {
  slug: "bitmart" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<BitmartDetailsResp>(
          "https://api-cloud-v2.bitmart.com/contract/public/details",
        ),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== 1000 || !Array.isArray(res.data?.symbols)) {
      throw new Error(`BitMart details: ${res.message ?? res.code}`);
    }

    const rows = res.data.symbols!.filter(
      (row) =>
        row.product_type === 1 &&
        row.quote_currency?.toUpperCase() === "USDT" &&
        (!row.status || row.status === "Trading") &&
        row.funding_rate !== undefined &&
        row.funding_rate !== "",
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      const base = row.base_currency.toUpperCase();
      const lp = row.last_price != null ? String(row.last_price) : undefined;

      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(row.funding_rate),
        nextFundingTime:
          row.funding_time != null ? new Date(row.funding_time) : null,
        markPrice: lp,
        bestBid: lp,
        bestAsk: lp,
        fundingIntervalHours: normalizeStandardFundingIntervalHours(
          row.funding_interval_hours,
        ),
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];
    const seen = new Set<number>();

    for (let page = 1; page <= 80; page++) {
      const url = new URL(
        "https://api-cloud-v2.bitmart.com/contract/public/funding-rate-history",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", "100");

      const res = await fetchWithRetry(
        () =>
          fetchJson<{
            code: number;
            message?: string;
            data?: { list?: BitmartHistRow[] };
          }>(url.toString()),
        { retries: 2, baseDelayMs: 400 },
      );
      if (res.code !== 1000 || !Array.isArray(res.data?.list)) break;

      let added = 0;
      for (const row of res.data.list!) {
        const t = Number(row.funding_time);
        if (!Number.isFinite(t)) continue;
        if (t < since || t > until) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({
          nativeSymbol: row.symbol ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.funding_rate),
        });
        added++;
      }
      if (res.data.list!.length === 0 || added === 0) break;
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const step = bitmartStepMinutes(intervalMin);
    const startSec = Math.floor(range.since.getTime() / 1000);
    const endSec = Math.floor(range.until.getTime() / 1000);
    const maxChunkSec = 14 * 24 * 60 * 60;
    const seen = new Set<number>();
    type K = {
      timestamp?: number;
      open_price?: string;
      high_price?: string;
      low_price?: string;
      close_price?: string;
    };
    const out: KlinePoint[] = [];

    for (let from = startSec; from <= endSec; from += maxChunkSec) {
      const to = Math.min(endSec, from + maxChunkSec - 1);
      const url = new URL(
        "https://api-cloud-v2.bitmart.com/contract/public/kline",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("step", String(step));
      url.searchParams.set("start_time", String(from));
      url.searchParams.set("end_time", String(to));

      let res: { code: number; message?: string; data?: unknown };
      try {
        res = await fetchWithRetry(
          () => fetchJson<{ code: number; message?: string; data?: unknown }>(url.toString()),
          { retries: 2, baseDelayMs: 450 },
        );
      } catch {
        continue;
      }
      if (res.code !== 1000 || !Array.isArray(res.data)) continue;

      for (const row of res.data as K[]) {
        const tSec = Number(row.timestamp);
        if (!Number.isFinite(tSec) || seen.has(tSec)) continue;
        seen.add(tSec);
        const t = tSec * 1000;
        const o = Number(row.open_price);
        const h = Number(row.high_price);
        const l = Number(row.low_price);
        const c = Number(row.close_price);
        if (!Number.isFinite(c)) continue;
        out.push({
          time: t,
          open: Number.isFinite(o) ? o : undefined,
          high: Number.isFinite(h) ? h : undefined,
          low: Number.isFinite(l) ? l : undefined,
          close: c,
        });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },
};
