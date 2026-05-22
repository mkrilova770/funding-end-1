import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import { mapLimit } from "@/lib/exchanges/parallel-limited";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

const WOO_BASE = "https://api.woo.org";

type WooFutRow = {
  symbol: string;
  est_funding_rate?: number;
  last_funding_rate?: number;
  next_funding_time?: number;
  mark_price?: number;
  index_price?: number;
};

type WooFutResp = { success: boolean; rows?: WooFutRow[] };

type WooFundRow = {
  symbol: string;
  funding_rate: number;
  funding_rate_timestamp: number;
  mark_price?: number;
};

type WooFundResp = {
  success: boolean;
  rows?: WooFundRow[];
  meta?: { total?: number; records_per_page?: number; current_page?: number };
};

type WooKlineRow = {
  symbol: string;
  type: string;
  start_timestamp: number;
  end_timestamp: number;
  open: number;
  close: number;
  high: number;
  low: number;
};

type WooKlineResp = { success: boolean; rows?: WooKlineRow[] };

type WooObResp = {
  success: boolean;
  asks?: { price: number; quantity: number }[];
  bids?: { price: number; quantity: number }[];
};

function baseFromWooSymbol(sym: string): string | null {
  const m = /^PERP_(.+)_(USDT)$/i.exec(sym);
  return m ? m[1]!.toUpperCase() : null;
}

function wooKlineType(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    480: "8h",
  };
  return m[intervalMin] ?? "4h";
}

export const wooxAdapter: ExchangeFundingAdapter = {
  slug: "woox" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () => fetchJson<WooFutResp>(`${WOO_BASE}/v1/public/futures`),
      { retries: 2, baseDelayMs: 400 },
    );
    if (!res.success || !Array.isArray(res.rows)) {
      throw new Error("WOO X futures: unexpected response");
    }

    const rows = res.rows.filter((r) => baseFromWooSymbol(r.symbol));
    const books = await mapLimit(rows, 20, async (row) => {
      const url = `${WOO_BASE}/v1/public/orderbook/${encodeURIComponent(row.symbol)}?max_level=1`;
      const ob = await fetchWithRetry(
        () => fetchJson<WooObResp>(url),
        { retries: 1, baseDelayMs: 200 },
      );
      return { row, ob };
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { row, ob } of books) {
      const base = baseFromWooSymbol(row.symbol);
      if (!base) continue;
      const rateRaw =
        row.est_funding_rate !== undefined && row.est_funding_rate !== 0
          ? row.est_funding_rate
          : row.last_funding_rate;
      if (rateRaw === undefined) continue;

      const nextMs = row.next_funding_time ?? NaN;
      const mp = row.mark_price ?? row.index_price;
      const lp = mp != null ? String(mp) : undefined;

      let bestBid = lp;
      let bestAsk = lp;
      if (ob.success) {
        const ap = ob.asks?.[0]?.price;
        const bp = ob.bids?.[0]?.price;
        const a = ap != null ? Number(ap) : NaN;
        const b = bp != null ? Number(bp) : NaN;
        if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
          bestAsk = String(a);
          bestBid = String(b);
        }
      }

      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(rateRaw),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: lp,
        bestBid,
        bestAsk,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];

    for (let page = 1; page <= 200; page++) {
      const url = new URL(`${WOO_BASE}/v1/public/funding_rate_history`);
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", "25");

      const res = await fetchWithRetry(
        () => fetchJson<WooFundResp>(url.toString()),
        { retries: 2, baseDelayMs: 400 },
      );
      if (!res.success || !Array.isArray(res.rows) || res.rows.length === 0)
        break;

      for (const row of res.rows) {
        const t = row.funding_rate_timestamp;
        if (!Number.isFinite(t) || t < since || t > until) continue;
        out.push({
          nativeSymbol: row.symbol ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.funding_rate),
        });
      }

      const total = res.meta?.total ?? 0;
      const per = res.meta?.records_per_page ?? 25;
      if (page * per >= total) break;
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const typ = wooKlineType(intervalMin);
    const url = new URL(`${WOO_BASE}/v1/public/kline`);
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("type", typ);
    url.searchParams.set("limit", "500");

    const res = await fetchWithRetry(
      () => fetchJson<WooKlineResp>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (!res.success || !Array.isArray(res.rows)) return [];

    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: KlinePoint[] = [];
    for (const row of res.rows) {
      const t = row.start_timestamp;
      if (!Number.isFinite(t) || t < since || t > until) continue;
      out.push({
        time: t,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },
};
