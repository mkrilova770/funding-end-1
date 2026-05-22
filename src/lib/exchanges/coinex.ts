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

type CoinexRow = {
  market: string;
  latest_funding_rate: string;
  next_funding_time?: number;
  mark_price?: string;
};

type CoinexResp = { code: number; message?: string; data?: CoinexRow[] };

type CoinexHistRow = {
  market: string;
  funding_time: number;
  actual_funding_rate?: string;
  theoretical_funding_rate?: string;
};

type CoinexHistResp = {
  code: number;
  message?: string;
  data?: CoinexHistRow[];
  pagination?: { has_next: boolean };
};

type CoinexKlineRow = {
  created_at: number;
  open: string;
  high: string;
  low: string;
  close: string;
};

type CoinexDepthResp = {
  code: number;
  message?: string;
  data?: {
    depth?: {
      bids?: [string, string][];
      asks?: [string, string][];
    };
  };
};

function coinexPeriod(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5min",
    30: "30min",
    60: "1hour",
    240: "4hour",
    480: "8hour",
  };
  return m[intervalMin] ?? "4hour";
}

export const coinexAdapter: ExchangeFundingAdapter = {
  slug: "coinex" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<CoinexResp>("https://api.coinex.com/v2/futures/funding-rate"),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) {
      throw new Error(`CoinEx funding-rate: ${res.message ?? res.code}`);
    }

    const depths = await mapLimit(res.data, 30, async (row) => {
      const url = `https://api.coinex.com/v2/futures/depth?market=${encodeURIComponent(row.market)}&limit=5&interval=0`;
      const d = await fetchWithRetry(
        () => fetchJson<CoinexDepthResp>(url),
        { retries: 1, baseDelayMs: 150 },
      );
      return { row, d };
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { row, d } of depths) {
      if (!row.market?.endsWith("USDT")) continue;
      const base = row.market.replace(/USDT$/i, "").toUpperCase();
      if (!base) continue;

      const nextMs = row.next_funding_time ?? NaN;
      const mp = row.mark_price != null ? String(row.mark_price) : undefined;
      let bestBid = mp;
      let bestAsk = mp;
      if (d.code === 0 && d.data?.depth) {
        const bid0 = d.data.depth.bids?.[0]?.[0];
        const ask0 = d.data.depth.asks?.[0]?.[0];
        const b = bid0 != null ? Number(bid0) : NaN;
        const a = ask0 != null ? Number(ask0) : NaN;
        if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
          bestBid = String(b);
          bestAsk = String(a);
        }
      }

      markets.push({
        nativeSymbol: row.market,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.market,
        rate: String(row.latest_funding_rate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: mp,
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
    const seen = new Set<number>();

    for (let page = 1; page <= 200; page++) {
      const url = new URL(
        "https://api.coinex.com/v2/futures/funding-rate-history",
      );
      url.searchParams.set("market", nativeSymbol);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", "100");
      url.searchParams.set("start_time", String(since));
      url.searchParams.set("end_time", String(until));

      const res = await fetchWithRetry(
        () => fetchJson<CoinexHistResp>(url.toString()),
        { retries: 2, baseDelayMs: 400 },
      );
      if (res.code !== 0 || !Array.isArray(res.data)) break;

      for (const row of res.data) {
        const t = row.funding_time;
        if (!Number.isFinite(t) || t < since || t > until) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        const rate =
          row.actual_funding_rate ?? row.theoretical_funding_rate ?? "0";
        out.push({
          nativeSymbol: row.market ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(rate),
        });
      }

      if (!res.pagination?.has_next || res.data.length === 0) break;
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const period = coinexPeriod(intervalMin);
    const url = new URL("https://api.coinex.com/v2/futures/kline");
    url.searchParams.set("market", nativeSymbol);
    url.searchParams.set("period", period);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("start_time", String(range.since.getTime()));
    url.searchParams.set("end_time", String(range.until.getTime()));

    const res = await fetchWithRetry(
      () =>
        fetchJson<{ code: number; message?: string; data?: CoinexKlineRow[] }>(
          url.toString(),
        ),
      { retries: 2, baseDelayMs: 450 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) return [];

    const out: KlinePoint[] = [];
    for (const row of res.data) {
      const t = row.created_at;
      if (!Number.isFinite(t)) continue;
      const o = Number(row.open);
      const h = Number(row.high);
      const l = Number(row.low);
      const c = Number(row.close);
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
