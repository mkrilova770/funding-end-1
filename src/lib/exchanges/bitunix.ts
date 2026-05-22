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

type BxRow = {
  symbol: string;
  fundingRate: string;
  nextFundingTime?: string;
  markPrice?: string;
  lastPrice?: string;
  /** Период в часах. */
  fundingInterval?: number;
};

type BxResp = { code: number; msg?: string; data?: BxRow[] };

function bitunixInterval(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    480: "8h",
  };
  return m[intervalMin] ?? "4h";
}

export const bitunixAdapter: ExchangeFundingAdapter = {
  slug: "bitunix" as ExchangeAdapterSlug,
  /** Публичной истории funding на момент интеграции нет — только свечи и текущая ставка. */
  supportsHistory: false,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<BxResp>(
          "https://fapi.bitunix.com/api/v1/futures/market/funding_rate/batch",
        ),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) {
      throw new Error(`Bitunix batch funding: ${res.msg ?? res.code}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.data) {
      if (!row.symbol?.endsWith("USDT")) continue;
      if (row.fundingRate === undefined || row.fundingRate === "") continue;
      const base = row.symbol.replace(/USDT$/i, "").toUpperCase();
      if (!base) continue;
      const rawRate = Number(row.fundingRate);
      if (!Number.isFinite(rawRate)) continue;
      // Bitunix returns funding as percent units; table expects fraction units.
      const normalizedRate = rawRate / 100;

      const nextMs = row.nextFundingTime ? Number(row.nextFundingTime) : NaN;
      const mp = row.markPrice ?? row.lastPrice;
      const lp = mp != null ? String(mp) : undefined;

      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: String(normalizedRate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: lp,
        bestBid: lp,
        bestAsk: lp,
        fundingIntervalHours: normalizeStandardFundingIntervalHours(
          row.fundingInterval,
        ),
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory() {
    return [] as FundingHistoryPoint[];
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const interval = bitunixInterval(intervalMin);
    const url = new URL(
      "https://fapi.bitunix.com/api/v1/futures/market/kline",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(range.since.getTime()));
    url.searchParams.set("endTime", String(range.until.getTime()));

    const res = await fetchWithRetry(
      () =>
        fetchJson<{
          code: number;
          msg?: string;
          data?: {
            open?: string;
            high?: string;
            low?: string;
            close?: string;
            time?: string;
          }[];
        }>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) return [];

    const out: KlinePoint[] = [];
    for (const row of res.data) {
      const t = row.time != null ? Number(row.time) : NaN;
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
