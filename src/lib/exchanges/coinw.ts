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

type CwInst = {
  name: string;
  base: string;
  quote: string;
  status?: string;
  settledAt?: number;
  settlementRate?: number;
  /** Период начисления в часах. */
  settledPeriod?: number;
};

type CwInstResp = { code: number; msg?: string; data?: CwInst[] };
type CwFundResp = { code: number; msg?: string; data?: { ts?: number; value?: number } };

type CwTicker = {
  base_coin: string;
  quote_coin: string;
  name: string;
  fair_price?: number;
  last_price?: number;
};
type CwTickerResp = { code: number; msg?: string; data?: CwTicker[] };

type CwKlineResp = { code: number; msg?: string; data?: (number | string)[][] };

function coinwGranularity(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "1",
    30: "8",
    60: "3",
    240: "4",
    480: "4",
  };
  return m[intervalMin] ?? "4";
}

function coinwBaseFromNative(nativeSymbol: string): string {
  return nativeSymbol.replace(/USDT$/i, "");
}

export const coinwAdapter: ExchangeFundingAdapter = {
  slug: "coinw" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const [instRes, tickerRes] = await Promise.all([
      fetchWithRetry(
        () =>
          fetchJson<CwInstResp>("https://api.coinw.com/v1/perpum/instruments"),
        { retries: 2, baseDelayMs: 400 },
      ),
      fetchWithRetry(
        () =>
          fetchJson<CwTickerResp>("https://api.coinw.com/v1/perpumPublic/tickers"),
        { retries: 2, baseDelayMs: 400 },
      ),
    ]);
    if (instRes.code !== 0 || !Array.isArray(instRes.data)) {
      throw new Error(`CoinW instruments: ${instRes.msg ?? instRes.code}`);
    }
    if (tickerRes.code !== 0 || !Array.isArray(tickerRes.data)) {
      throw new Error(`CoinW tickers: ${tickerRes.msg ?? tickerRes.code}`);
    }

    const tickerByBase = new Map<string, CwTicker>();
    for (const t of tickerRes.data) {
      if (t.quote_coin?.toLowerCase() !== "usdt") continue;
      const b = t.base_coin?.toUpperCase();
      if (!b) continue;
      tickerByBase.set(b, t);
    }

    const usdtOnline = instRes.data.filter(
      (r) =>
        r.quote?.toLowerCase() === "usdt" &&
        (!r.status || r.status === "online"),
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of usdtOnline) {
      // Use settlement data from instruments to avoid Cloudflare 1015 bursts.
      const rate = Number(row.settlementRate);
      if (!Number.isFinite(rate)) continue;
      const base = row.base.toUpperCase();
      const native = row.name?.toUpperCase() || `${base}USDT`;
      const ts = row.settledAt;
      const t = tickerByBase.get(base);
      const px = t?.fair_price ?? t?.last_price;
      const mark = Number.isFinite(Number(px)) && Number(px) > 0 ? String(px) : undefined;

      markets.push({
        nativeSymbol: native,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: native,
        rate: String(rate),
        nextFundingTime: ts != null ? new Date(ts) : null,
        markPrice: mark,
        bestBid: mark,
        bestAsk: mark,
        fundingIntervalHours: normalizeStandardFundingIntervalHours(
          row.settledPeriod,
        ),
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const inst = coinwBaseFromNative(nativeSymbol).toLowerCase();
    const url = `https://api.coinw.com/v1/perpum/fundingRate?instrument=${encodeURIComponent(inst)}`;
    const res = await fetchWithRetry(
      () => fetchJson<CwFundResp>(url),
      { retries: 2, baseDelayMs: 350 },
    );
    if (res.code !== 0 || res.data?.value === undefined || res.data.ts === undefined) {
      throw new Error(`CoinW fundingRate: ${res.msg ?? res.code}`);
    }
    const t = Number(res.data.ts);
    if (!Number.isFinite(t) || t < range.since.getTime() || t > range.until.getTime()) {
      return [];
    }
    return [{
      nativeSymbol,
      fundingTime: new Date(t),
      rate: String(res.data.value),
    }] as FundingHistoryPoint[];
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const base = coinwBaseFromNative(nativeSymbol).toUpperCase();
    const granularity = coinwGranularity(intervalMin);
    const url = new URL("https://api.coinw.com/v1/perpumPublic/klines");
    url.searchParams.set("currencyCode", base);
    url.searchParams.set("granularity", granularity);
    url.searchParams.set("sinceStr", String(range.since.getTime()));
    url.searchParams.set("sinceEndStr", String(range.until.getTime()));
    url.searchParams.set("limit", "1500");

    const res = await fetchWithRetry(
      () => fetchJson<CwKlineResp>(url.toString()),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) {
      throw new Error(`CoinW klines: ${res.msg ?? res.code}`);
    }

    const out: KlinePoint[] = [];
    for (const r of res.data) {
      const t = Number(r[0]);
      const open = Number(r[1]);
      const high = Number(r[2]);
      const low = Number(r[3]);
      const close = Number(r[4]);
      if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
      out.push({ time: t, open, high, low, close });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },
};
