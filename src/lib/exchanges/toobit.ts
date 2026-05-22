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

type ToobitRow = {
  symbol: string;
  rate: string;
  nextFundingTime?: string;
  markPrice?: string;
  indexPrice?: string;
  /** Напр. «1H», «4H», «8H». */
  period?: string;
};

type ToobitBookTicker = {
  s: string;
  b: string;
  a: string;
};

type ToobitHistRow = {
  symbol: string;
  settleTime: string;
  settleRate: string;
};

function toobitFundingPeriodHours(period: string | undefined): number | null {
  if (!period || typeof period !== "string") return null;
  const m = /^(\d+)\s*H$/i.exec(period.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toobitInterval(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    480: "8h",
  };
  return m[intervalMin] ?? "4h";
}

export const toobitAdapter: ExchangeFundingAdapter = {
  slug: "toobit" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const [rows, books] = await Promise.all([
      fetchWithRetry(
        () =>
          fetchJson<ToobitRow[]>(
            "https://api.toobit.com/api/v1/futures/fundingRate",
          ),
        { retries: 2, baseDelayMs: 400 },
      ),
      fetchWithRetry(
        () =>
          fetchJson<ToobitBookTicker[]>(
            "https://api.toobit.com/quote/v1/contract/ticker/bookTicker",
          ),
        { retries: 2, baseDelayMs: 400 },
      ),
    ]);
    if (!Array.isArray(rows)) {
      throw new Error("Toobit fundingRate: expected array");
    }

    const bookMap = new Map<string, ToobitBookTicker>();
    if (Array.isArray(books)) {
      for (const b of books) {
        if (b?.s) bookMap.set(b.s, b);
      }
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      if (!row.symbol?.endsWith("-SWAP-USDT")) continue;
      const base = row.symbol.replace(/-SWAP-USDT$/i, "").toUpperCase();
      if (!base) continue;
      const native = row.symbol;
      const nextMs = row.nextFundingTime ? Number(row.nextFundingTime) : NaN;
      const mp = row.markPrice ?? row.indexPrice;
      const lp = mp != null ? String(mp) : undefined;
      const bt = bookMap.get(native);
      const bidN = bt ? Number(bt.b) : NaN;
      const askN = bt ? Number(bt.a) : NaN;
      const bestBid = Number.isFinite(bidN) && bidN > 0 ? String(bidN) : lp;
      const bestAsk = Number.isFinite(askN) && askN > 0 ? String(askN) : lp;

      markets.push({
        nativeSymbol: native,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      const rawH = toobitFundingPeriodHours(row.period);
      latest.push({
        nativeSymbol: native,
        rate: String(row.rate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: lp,
        bestBid,
        bestAsk,
        fundingIntervalHours: normalizeStandardFundingIntervalHours(rawH),
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const url = new URL("https://api.toobit.com/api/v1/futures/historyFundingRate");
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("limit", "1000");

    const rows = await fetchWithRetry(
      () => fetchJson<ToobitHistRow[]>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (!Array.isArray(rows)) {
      throw new Error("Toobit historyFundingRate: expected array");
    }

    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];

    for (const row of rows) {
      const t = Number(row.settleTime);
      if (!Number.isFinite(t) || t < since || t > until) continue;
      out.push({
        nativeSymbol: row.symbol ?? nativeSymbol,
        fundingTime: new Date(t),
        rate: String(row.settleRate),
      });
    }
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const interval = toobitInterval(intervalMin);
    const url = new URL("https://api.toobit.com/quote/v1/klines");
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(range.since.getTime()));
    url.searchParams.set("endTime", String(range.until.getTime()));
    url.searchParams.set("limit", "1000");

    const rows = await fetchWithRetry(
      () => fetchJson<(string | number)[][]>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (!Array.isArray(rows)) return [];

    const out: KlinePoint[] = [];
    for (const r of rows) {
      const t = Number(r[0]);
      if (!Number.isFinite(t)) continue;
      const open = Number(r[1]);
      const high = Number(r[2]);
      const low = Number(r[3]);
      const close = Number(r[4]);
      if (!Number.isFinite(close)) continue;
      out.push({ time: t, open, high, low, close });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  },
};
