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

type PhProduct = {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
};

type PhProductsResp = {
  code: number;
  msg?: string;
  data?: { perpProductsV2?: PhProduct[] };
};

type PhTickerResp = {
  error: unknown;
  result?: {
    symbol: string;
    fundingRateRr?: string;
    predFundingRateRr?: string;
    markPriceRp?: string;
    closeRp?: string;
    indexPriceRp?: string;
  };
};

function phemexFundingSymbol(nativeUsdtPerp: string): string {
  return `.${nativeUsdtPerp}FR8H`;
}

function phemexResolutionSec(intervalMin: number): number {
  const m: Record<number, number> = {
    5: 300,
    30: 1800,
    60: 3600,
    240: 14400,
    480: 28800,
  };
  return m[intervalMin] ?? 14400;
}

export const phemexAdapter: ExchangeFundingAdapter = {
  slug: "phemex" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const pr = await fetchWithRetry(
      () => fetchJson<PhProductsResp>("https://api.phemex.com/public/products"),
      { retries: 2, baseDelayMs: 400 },
    );
    if (pr.code !== 0 || !Array.isArray(pr.data?.perpProductsV2)) {
      throw new Error(`Phemex products: ${pr.msg ?? pr.code}`);
    }

    const symbols = pr.data.perpProductsV2!.filter(
      (p) =>
        p.quoteCurrency === "USDT" &&
        p.status === "Listed" &&
        p.symbol?.endsWith("USDT"),
    );

    const ticked = await mapLimit(symbols, 25, async (p) => {
      const url = `https://api.phemex.com/md/v2/ticker/24hr?symbol=${encodeURIComponent(p.symbol)}`;
      const t = await fetchWithRetry(
        () => fetchJson<PhTickerResp>(url),
        { retries: 1, baseDelayMs: 250 },
      );
      return { p, t };
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { p, t } of ticked) {
      if (t.error != null || !t.result) continue;
      const r = t.result;
      const rateRaw = r.predFundingRateRr ?? r.fundingRateRr;
      if (rateRaw === undefined) continue;

      const mp = r.markPriceRp ?? r.closeRp ?? r.indexPriceRp;
      const lp = mp != null ? String(mp) : undefined;

      markets.push({
        nativeSymbol: p.symbol,
        baseAsset: p.baseCurrency.toUpperCase(),
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: p.symbol,
        rate: String(rateRaw),
        nextFundingTime: null,
        markPrice: lp,
        bestBid: lp,
        bestAsk: lp,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    if (!nativeSymbol.endsWith("USDT")) {
      return [];
    }
    const since = range.since.getTime();
    const until = range.until.getTime();
    const histSym = phemexFundingSymbol(nativeSymbol);
    const out: FundingHistoryPoint[] = [];
    const seen = new Set<number>();

    for (let offset = 0; offset < 8000; offset += 100) {
      const url = new URL(
        "https://api.phemex.com/api-data/public/data/funding-rate-history",
      );
      url.searchParams.set("symbol", histSym);
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));

      const res = await fetchWithRetry(
        () =>
          fetchJson<{
            code: number;
            msg?: string;
            data?: {
              rows?: {
                symbol: string;
                fundingRate: string;
                fundingTime: number;
              }[];
            };
          }>(url.toString()),
        { retries: 2, baseDelayMs: 450 },
      );
      if (res.code !== 0 || !Array.isArray(res.data?.rows)) break;

      const rows = res.data.rows!;
      if (rows.length === 0) break;

      for (const row of rows) {
        const t = row.fundingTime;
        if (!Number.isFinite(t) || seen.has(t)) continue;
        if (t < since || t > until) continue;
        seen.add(t);
        out.push({
          nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.fundingRate),
        });
      }

      if (rows.length < 100) break;
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const resolution = phemexResolutionSec(intervalMin);
    const sinceSec = Math.floor(range.since.getTime() / 1000);
    const untilSec = Math.floor(range.until.getTime() / 1000);

    const url = new URL(
      "https://api.phemex.com/exchange/public/md/v2/kline/last",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("resolution", String(resolution));
    url.searchParams.set("limit", "500");

    const res = await fetchWithRetry(
      () =>
        fetchJson<{
          code: number;
          msg?: string;
          data?: { rows?: (string | number)[][] };
        }>(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== 0 || !Array.isArray(res.data?.rows)) return [];

    const out: KlinePoint[] = [];
    for (const row of res.data.rows!) {
      const tSec = Number(row[0]);
      if (!Number.isFinite(tSec)) continue;
      const t = tSec * 1000;
      if (t < range.since.getTime() || t > range.until.getTime()) continue;
      if (tSec < sinceSec || tSec > untilSec) continue;
      const o = Number(row[3]);
      const h = Number(row[4]);
      const l = Number(row[5]);
      const c = Number(row[6]);
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
