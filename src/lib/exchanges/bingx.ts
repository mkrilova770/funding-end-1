import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type BingxResp<T> = { code: number; msg: string; data: T };

type BingxPremiumRow = {
  symbol: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
  markPrice?: string;
};

function baseFromSymbol(symbol: string): string | null {
  if (!symbol.endsWith("-USDT")) return null;
  const base = symbol.slice(0, -"-USDT".length);
  return base ? base.toUpperCase() : null;
}

export const bingxAdapter: ExchangeFundingAdapter = {
  slug: "bingx" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const premium = await fetchWithRetry(
      () =>
        fetchJson<BingxResp<BingxPremiumRow[]>>(
          "https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex",
          { timeoutMs: 25_000 },
        ),
      { retries: 2, baseDelayMs: 400 },
    );
    if (premium.code !== 0) {
      throw new Error(`BingX premiumIndex: ${premium.msg}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of premium.data ?? []) {
      const base = baseFromSymbol(row.symbol);
      if (!base) continue;
      const rate = row.lastFundingRate;
      if (rate === undefined || rate === "") continue;

      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate,
        nextFundingTime:
          row.nextFundingTime != null
            ? new Date(row.nextFundingTime)
            : null,
        markPrice: row.markPrice,
      });
    }

    try {
      const tickerRes = await fetchWithRetry(
        () =>
          fetchJson<
            BingxResp<{ symbol: string; bidPrice: string; askPrice: string }[]>
          >("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", {
            timeoutMs: 15_000,
          }),
        { retries: 1, baseDelayMs: 300 },
      );
      if (tickerRes.code === 0 && Array.isArray(tickerRes.data)) {
        const baMap = new Map(
          tickerRes.data.map((r) => [
            r.symbol,
            { bid: r.bidPrice, ask: r.askPrice },
          ]),
        );
        for (const l of latest) {
          const ba = baMap.get(l.nativeSymbol);
          if (ba) {
            l.bestBid = ba.bid;
            l.bestAsk = ba.ask;
          }
        }
      }
    } catch { /* ticker bid/ask is optional */ }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const url = new URL(
      "https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("startTime", String(range.since.getTime()));
    url.searchParams.set("endTime", String(range.until.getTime()));

    const fr = await fetchWithRetry(
      () =>
        fetchJson<
          BingxResp<
            { symbol: string; fundingRate: string; fundingTime: string }[]
          >
        >(url.toString()),
      { retries: 2, baseDelayMs: 500 },
    );
    if (fr.code !== 0) {
      throw new Error(`BingX funding history: ${fr.msg}`);
    }

    return (fr.data ?? []).map((row) => ({
      nativeSymbol: row.symbol,
      fundingTime: new Date(Number(row.fundingTime)),
      rate: row.fundingRate,
    }));
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = { 5: "5m", 30: "30m", 60: "1h", 240: "4h", 480: "8h" };
    const interval = intervalMap[intervalMin] ?? "4h";
    const url = new URL(
      "https://open-api.bingx.com/openApi/swap/v2/quote/klines",
    );
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(range.since.getTime()));
    url.searchParams.set("endTime", String(range.until.getTime()));
    url.searchParams.set("limit", "1440");

    const res = await fetchWithRetry(
      () =>
        fetchJson<
          BingxResp<{ close: string; time: number }[]>
        >(url.toString(), { timeoutMs: 25_000 }),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) return [];

    return res.data.map((r) => ({
      time: r.time,
      close: Number(r.close),
    }));
  },
};
