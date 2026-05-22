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

type WbRow = {
  ticker_id: string;
  stock_currency: string;
  money_currency: string;
  funding_rate?: string;
  next_funding_rate_timestamp?: string;
  last_price?: string;
  index_price?: string;
  bid?: string;
  ask?: string;
  product_type?: string;
  funding_interval_minutes?: number | string;
};

type WbResp = { success: boolean; message?: string | null; result?: WbRow[] };

type WbFundHistRow = {
  fundingTime: string;
  fundingRate: string;
  market: string;
  settlementPrice?: string;
};

function whitebitIntervalSec(intervalMin: number): number {
  const m: Record<number, number> = {
    5: 300,
    30: 1800,
    60: 3600,
    240: 14400,
    480: 28800,
  };
  return m[intervalMin] ?? 14400;
}

async function fetchWhitebitWsKlines(
  nativeSymbol: string,
  sinceMs: number,
  untilMs: number,
  intervalSec: number,
): Promise<KlinePoint[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://api.whitebit.com/ws");
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve([]);
    }, 12_000);

    ws.onopen = () => {
      const from = Math.floor(sinceMs / 1000);
      const to = Math.floor(untilMs / 1000);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "candles_request",
          params: [nativeSymbol, from, to, intervalSec],
        }),
      );
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          error?: unknown;
          result?: Array<[number, string, string, string, string]>;
        };
        if (!Array.isArray(msg.result)) return;
        const out: KlinePoint[] = [];
        for (const row of msg.result) {
          const tSec = Number(row[0]);
          const open = Number(row[1]);
          const close = Number(row[2]);
          const high = Number(row[3]);
          const low = Number(row[4]);
          if (!Number.isFinite(tSec) || !Number.isFinite(close)) continue;
          const time = tSec * 1000;
          out.push({
            time,
            open: Number.isFinite(open) ? open : undefined,
            high: Number.isFinite(high) ? high : undefined,
            low: Number.isFinite(low) ? low : undefined,
            close,
          });
        }
        out.sort((a, b) => a.time - b.time);
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(out);
      } catch {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve([]);
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve([]);
    };
  });
}

export const whitebitAdapter: ExchangeFundingAdapter = {
  slug: "whitebit" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<WbResp>("https://whitebit.com/api/v4/public/futures"),
      { retries: 2, baseDelayMs: 400 },
    );
    if (!res.success || !Array.isArray(res.result)) {
      throw new Error(`WhiteBIT futures: ${res.message ?? "fail"}`);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of res.result) {
      if (row.money_currency?.toUpperCase() !== "USDT") continue;
      if (row.product_type && row.product_type !== "Perpetual") continue;
      if (row.funding_rate === undefined || row.funding_rate === "") continue;

      const base = row.stock_currency.toUpperCase();
      const nextMs = row.next_funding_rate_timestamp
        ? Number(row.next_funding_rate_timestamp)
        : NaN;
      const mp =
        row.last_price != null
          ? String(row.last_price)
          : row.index_price != null
            ? String(row.index_price)
            : undefined;
      const bidN = row.bid != null ? Number(row.bid) : NaN;
      const askN = row.ask != null ? Number(row.ask) : NaN;
      const bestBid = Number.isFinite(bidN) && bidN > 0 ? String(bidN) : mp;
      const bestAsk = Number.isFinite(askN) && askN > 0 ? String(askN) : mp;

      const fundMin = row.funding_interval_minutes;
      const fundMinN =
        fundMin === "" || fundMin === undefined || fundMin === null
          ? NaN
          : Number(fundMin);
      const fundingIntervalHours = Number.isFinite(fundMinN)
        ? normalizeStandardFundingIntervalHours(fundMinN / 60)
        : null;

      markets.push({
        nativeSymbol: row.ticker_id,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.ticker_id,
        rate: String(row.funding_rate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: mp,
        bestBid,
        bestAsk,
        fundingIntervalHours,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const sinceSec = Math.floor(range.since.getTime() / 1000);
    const untilSec = Math.floor(range.until.getTime() / 1000);
    const out: FundingHistoryPoint[] = [];
    const seen = new Set<number>();
    for (let offset = 0; offset < 10_000; offset += 100) {
      const url = new URL(
        `https://whitebit.com/api/v4/public/funding-history/${encodeURIComponent(nativeSymbol)}`,
      );
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("startDate", String(sinceSec));
      url.searchParams.set("endDate", String(untilSec));

      const rows = await fetchWithRetry(
        () => fetchJson<WbFundHistRow[]>(url.toString()),
        { retries: 2, baseDelayMs: 400 },
      );
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        const tSec = Number(row.fundingTime);
        if (!Number.isFinite(tSec)) continue;
        const t = tSec * 1000;
        if (t < range.since.getTime() || t > range.until.getTime()) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({
          nativeSymbol: row.market ?? nativeSymbol,
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
    const intervalSec = whitebitIntervalSec(intervalMin);
    return fetchWhitebitWsKlines(
      nativeSymbol,
      range.since.getTime(),
      range.until.getTime(),
      intervalSec,
    );
  },
};
