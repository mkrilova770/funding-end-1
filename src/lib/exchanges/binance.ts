import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type BinancePremium = {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime?: string;
  markPrice?: string;
};

function baseFromSymbol(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  if (!base) return null;
  return base.toUpperCase();
}

export const binanceAdapter: ExchangeFundingAdapter = {
  slug: "binance" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const rows = await fetchWithRetry(
      () =>
        fetchJson<BinancePremium[]>(
          "https://fapi.binance.com/fapi/v1/premiumIndex",
        ),
      { retries: 2, baseDelayMs: 400 },
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      const base = baseFromSymbol(row.symbol);
      if (!base) continue;
      markets.push({
        nativeSymbol: row.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.symbol,
        rate: row.lastFundingRate,
        nextFundingTime: row.nextFundingTime
          ? new Date(Number(row.nextFundingTime))
          : null,
        markPrice: row.markPrice,
      });
    }

    try {
      const bookTickers = await fetchWithRetry(
        () =>
          fetchJson<{ symbol: string; bidPrice: string; askPrice: string }[]>(
            "https://fapi.binance.com/fapi/v1/ticker/bookTicker",
          ),
        { retries: 1, baseDelayMs: 300 },
      );
      const btMap = new Map(
        bookTickers.map((b) => [b.symbol, { bid: b.bidPrice, ask: b.askPrice }]),
      );
      for (const l of latest) {
        const bt = btMap.get(l.nativeSymbol);
        if (bt) {
          l.bestBid = bt.bid;
          l.bestAsk = bt.ask;
        }
      }
    } catch { /* bookTicker is optional */ }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    const limit = 1000;
    let startTime = range.since.getTime();
    const end = range.until.getTime();

    // Binance: funding каждые 8ч — 1000 точек покрывают >330 дней; всё равно двигаем окно на случай лимита
    while (startTime < end) {
      const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("startTime", String(startTime));
      url.searchParams.set("endTime", String(end));
      url.searchParams.set("limit", String(limit));

      const chunk = await fetchWithRetry(
        () =>
          fetchJson<
            { fundingTime: number; fundingRate: string; symbol: string }[]
          >(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );

      if (chunk.length === 0) break;

      for (const p of chunk) {
        out.push({
          nativeSymbol: p.symbol,
          fundingTime: new Date(p.fundingTime),
          rate: p.fundingRate,
        });
      }

      const last = chunk[chunk.length - 1];
      const nextStart = last.fundingTime + 1;
      if (nextStart <= startTime) break;
      startTime = nextStart;
      if (chunk.length < limit) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const intervalMap: Record<number, string> = { 5: "5m", 30: "30m", 60: "1h", 240: "4h", 480: "8h" };
    const interval = intervalMap[intervalMin] ?? "4h";
    const out: KlinePoint[] = [];
    let startTime = range.since.getTime();
    const end = range.until.getTime();

    while (startTime < end) {
      const url = new URL("https://fapi.binance.com/fapi/v1/klines");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(startTime));
      url.searchParams.set("endTime", String(end));
      url.searchParams.set("limit", "1500");

      const rows = await fetchWithRetry(
        () => fetchJson<(string | number)[][]>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (rows.length === 0) break;

      for (const r of rows) {
        out.push({ time: Number(r[0]), close: Number(r[4]) });
      }

      const last = rows[rows.length - 1]!;
      const nextStart = Number(last[0]) + 1;
      if (nextStart <= startTime) break;
      startTime = nextStart;
      if (rows.length < 1500) break;
    }

    return out;
  },
};
