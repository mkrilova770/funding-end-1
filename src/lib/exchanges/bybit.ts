import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import { mapLimit } from "@/lib/exchanges/parallel-limited";
import { normalizeStandardFundingIntervalHours } from "@/lib/formatters/funding";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type BybitTicker = {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: string;
  markPrice?: string;
  bid1Price?: string;
  ask1Price?: string;
};

type BybitTickersResp = {
  retCode: number;
  retMsg: string;
  result: { category: string; list: BybitTicker[]; nextPageCursor?: string };
};

type BybitInstrumentRow = {
  symbol: string;
  contractType: string;
  status: string;
  quoteCoin: string;
  /** Минуты между начислениями (напр. 480 = 8 ч). */
  fundingInterval?: number;
};

type BybitInstrumentsResp = {
  retCode: number;
  retMsg: string;
  result: {
    category: string;
    list: BybitInstrumentRow[];
    nextPageCursor?: string;
  };
};

type BybitFundingHistoryResp = {
  retCode: number;
  retMsg: string;
  result: {
    category: string;
    list: {
      symbol: string;
      fundingRate: string;
      fundingRateTimestamp: string;
    }[];
  };
};

function baseFromLinearUsdt(symbol: string): string | null {
  if (!symbol.endsWith("USDT")) return null;
  const base = symbol.slice(0, -4);
  return base ? base.toUpperCase() : null;
}

async function fetchAllLinearUsdtTickers(): Promise<BybitTicker[]> {
  const all: BybitTicker[] = [];
  let cursor: string | undefined = undefined;

  for (let page = 0; page < 50; page++) {
    const url = new URL("https://api.bybit.com/v5/market/tickers");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await fetchWithRetry(
      () => fetchJson<BybitTickersResp>(url.toString()),
      { retries: 2, baseDelayMs: 400 },
    );
    if (data.retCode !== 0) {
      throw new Error(`Bybit tickers: ${data.retMsg}`);
    }
    const list = data.result.list ?? [];
    for (const t of list) {
      if (t.symbol.endsWith("USDT") && !t.symbol.includes("-")) {
        all.push(t);
      }
    }
    cursor = data.result.nextPageCursor;
    if (!cursor || list.length === 0) break;
  }

  return all;
}

/**
 * USDT linear perpetuals eligible for the table.
 * Bybit marks some actively quoted contracts (e.g. pre-list perps like BPUSDT) as `PreLaunch`, not `Trading`.
 */
async function fetchTradableLinearUsdtMeta(): Promise<{
  tradable: Set<string>;
  fundingIntervalMinBySymbol: Map<string, number>;
}> {
  const tradable = new Set<string>();
  const fundingIntervalMinBySymbol = new Map<string, number>();
  let cursor: string | undefined = undefined;

  for (let page = 0; page < 50; page++) {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await fetchWithRetry(
      () => fetchJson<BybitInstrumentsResp>(url.toString()),
      { retries: 2, baseDelayMs: 400 },
    );
    if (data.retCode !== 0) {
      throw new Error(`Bybit instruments-info: ${data.retMsg}`);
    }
    const list = data.result.list ?? [];
    for (const row of list) {
      const statusOk =
        row.status === "Trading" || row.status === "PreLaunch";
      if (
        statusOk &&
        row.contractType === "LinearPerpetual" &&
        row.quoteCoin === "USDT" &&
        row.symbol.endsWith("USDT") &&
        !row.symbol.includes("-")
      ) {
        tradable.add(row.symbol);
        if (
          typeof row.fundingInterval === "number" &&
          row.fundingInterval > 0
        ) {
          fundingIntervalMinBySymbol.set(row.symbol, row.fundingInterval);
        }
      }
    }
    cursor = data.result.nextPageCursor;
    if (!cursor || list.length === 0) break;
  }

  return { tradable, fundingIntervalMinBySymbol };
}

/**
 * Иногда контракт есть в tickers, но не попадает в страницу `instruments-info` без `symbol=`
 * (пример: BPUSDT в PreLaunch). Дополняем whitelist точечным запросом по символу.
 */
async function augmentTradableFromOrphanTickers(
  tickers: BybitTicker[],
  tradable: Set<string>,
  fundingIntervalMinBySymbol: Map<string, number>,
): Promise<void> {
  const seenOrphan = new Set<string>();
  const orphans: BybitTicker[] = [];
  for (const t of tickers) {
    if (!t.symbol.endsWith("USDT") || t.symbol.includes("-")) continue;
    if (tradable.has(t.symbol)) continue;
    if (seenOrphan.has(t.symbol)) continue;
    seenOrphan.add(t.symbol);
    orphans.push(t);
  }
  if (orphans.length === 0) return;

  await mapLimit(orphans, 8, async (t) => {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", t.symbol);

    const data = await fetchWithRetry(
      () => fetchJson<BybitInstrumentsResp>(url.toString()),
      { retries: 2, baseDelayMs: 400 },
    );
    if (data.retCode !== 0) return;

    const row = data.result.list?.[0] as BybitInstrumentRow | undefined;
    if (!row) return;

    const statusOk = row.status === "Trading" || row.status === "PreLaunch";
    if (
      statusOk &&
      row.contractType === "LinearPerpetual" &&
      row.quoteCoin === "USDT" &&
      row.symbol.endsWith("USDT") &&
      !row.symbol.includes("-")
    ) {
      tradable.add(row.symbol);
      if (
        typeof row.fundingInterval === "number" &&
        row.fundingInterval > 0
      ) {
        fundingIntervalMinBySymbol.set(row.symbol, row.fundingInterval);
      }
    }
  });
}

export const bybitAdapter: ExchangeFundingAdapter = {
  slug: "bybit" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const [tickers, meta] = await Promise.all([
      fetchAllLinearUsdtTickers(),
      fetchTradableLinearUsdtMeta(),
    ]);
    await augmentTradableFromOrphanTickers(
      tickers,
      meta.tradable,
      meta.fundingIntervalMinBySymbol,
    );

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const t of tickers) {
      if (!meta.tradable.has(t.symbol)) continue;
      const base = baseFromLinearUsdt(t.symbol);
      if (!base) continue;
      if (t.fundingRate === undefined) continue;
      const minIv = meta.fundingIntervalMinBySymbol.get(t.symbol);
      const intervalH =
        minIv !== undefined
          ? normalizeStandardFundingIntervalHours(minIv / 60)
          : null;
      markets.push({
        nativeSymbol: t.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: t.symbol,
        rate: t.fundingRate,
        nextFundingTime: t.nextFundingTime
          ? new Date(Number(t.nextFundingTime))
          : null,
        markPrice: t.markPrice,
        bestBid: t.bid1Price,
        bestAsk: t.ask1Price,
        fundingIntervalHours: intervalH,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    let endTime = range.until.getTime();
    const start = range.since.getTime();

    for (let i = 0; i < 200; i++) {
      const url = new URL("https://api.bybit.com/v5/market/funding/history");
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("limit", "200");
      url.searchParams.set("endTime", String(endTime));

      const data = await fetchWithRetry(
        () => fetchJson<BybitFundingHistoryResp>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.retCode !== 0) {
        throw new Error(`Bybit funding history: ${data.retMsg}`);
      }
      const list = data.result.list ?? [];
      if (list.length === 0) break;

      for (const row of list) {
        const ft = Number(row.fundingRateTimestamp);
        if (ft < start) {
          return out.filter((p) => p.fundingTime.getTime() >= start);
        }
        out.push({
          nativeSymbol: row.symbol,
          fundingTime: new Date(ft),
          rate: row.fundingRate,
        });
      }

      const oldest = list[list.length - 1];
      const oldestMs = Number(oldest.fundingRateTimestamp);
      if (oldestMs >= endTime) break;
      endTime = oldestMs - 1;
      if (list.length < 200) break;
    }

    return out.filter((p) => p.fundingTime.getTime() >= start);
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const out: KlinePoint[] = [];
    let start = range.since.getTime();
    const end = range.until.getTime();

    while (start < end) {
      const url = new URL("https://api.bybit.com/v5/market/kline");
      url.searchParams.set("category", "linear");
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("interval", String(intervalMin));
      url.searchParams.set("start", String(start));
      url.searchParams.set("end", String(end));
      url.searchParams.set("limit", "1000");

      const data = await fetchWithRetry(
        () =>
          fetchJson<{
            retCode: number;
            result: { list: string[][] };
          }>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.retCode !== 0) break;
      const list = data.result.list ?? [];
      if (list.length === 0) break;

      for (const r of list) {
        out.push({ time: Number(r[0]), close: Number(r[4]) });
      }

      const times = list.map((r) => Number(r[0]));
      const maxTime = Math.max(...times);
      const nextStart = maxTime + 1;
      if (nextStart <= start) break;
      start = nextStart;
      if (list.length < 1000) break;
    }

    return out.sort((a, b) => a.time - b.time);
  },
};
