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

type AdxContract = {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: number;
  markPrice?: string;
  lastPrice?: string;
};

type AdxResp = { code: number; data?: { contracts?: AdxContract[] } };

type AdxDepthResp = {
  code: number;
  data?: {
    data?: {
      asks?: [string, string][];
      bids?: [string, string][];
    };
  };
};

type AdxBarRow = {
  m?: string;
  s?: string;
  data?: {
    ts?: number;
    o?: string;
    h?: string;
    l?: string;
    c?: string;
    i?: string;
  };
};

type AdxFundingRatesRow = {
  timestamp?: number | string;
  symbol?: string;
  fundingRate?: string;
};

type AdxFundingRatesResp = {
  code?: number | string;
  data?: {
    data?: AdxFundingRatesRow[];
    hasNext?: boolean;
  };
};

/** AscendEX отдаёт ms; на всякий случай принимаем строку и секунды (как у части REST). */
function parseAdxFundingTimeMs(row: AdxFundingRatesRow): number | null {
  const raw = row.timestamp;
  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") {
    n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
  } else return null;
  if (n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function ascendexIntervalStr(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5",
    30: "30",
    60: "60",
    240: "240",
    480: "480",
  };
  return m[intervalMin] ?? "240";
}

export const ascendexAdapter: ExchangeFundingAdapter = {
  slug: "ascendex" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<AdxResp>(
          "https://ascendex.com/api/pro/v2/futures/pricing-data",
        ),
      { retries: 2, baseDelayMs: 500 },
    );
    if (res.code !== 0 || !Array.isArray(res.data?.contracts)) {
      throw new Error(`AscendEX pricing-data: code ${res.code}`);
    }

    const contracts = res.data.contracts!.filter(
      (row) =>
        row.symbol?.endsWith("-PERP") &&
        row.fundingRate !== undefined &&
        row.fundingRate !== "",
    );

    const enriched = await mapLimit(contracts, 25, async (row) => {
      const url = `https://ascendex.com/api/pro/v1/depth?symbol=${encodeURIComponent(row.symbol)}`;
      const dep = await fetchWithRetry(
        () => fetchJson<AdxDepthResp>(url),
        { retries: 1, baseDelayMs: 200 },
      );
      return { row, dep };
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { row, dep } of enriched) {
      const base = row.symbol.replace(/-PERP$/i, "").toUpperCase();
      if (!base) continue;

      const nextMs = row.nextFundingTime ?? NaN;
      const mp = row.markPrice ?? row.lastPrice;
      const lp = mp != null ? String(mp) : undefined;
      let bestBid = lp;
      let bestAsk = lp;
      if (dep.code === 0 && dep.data?.data) {
        const ask0 = dep.data.data.asks?.[0]?.[0];
        const bid0 = dep.data.data.bids?.[0]?.[0];
        const a = ask0 != null ? Number(ask0) : NaN;
        const b = bid0 != null ? Number(bid0) : NaN;
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
        rate: String(row.fundingRate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: lp,
        bestBid,
        bestAsk,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const sinceMs = range.since.getTime();
    const untilMs = range.until.getTime() + 60 * 60 * 1000;
    const out: FundingHistoryPoint[] = [];
    const pageSize = 100;
    const maxPages = 200;

    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(
        "https://ascendex.com/api/pro/v2/futures/funding-rates",
      );
      url.searchParams.set("symbol", nativeSymbol);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));

      const res = await fetchWithRetry(
        () => fetchJson<AdxFundingRatesResp>(url.toString()),
        { retries: 2, baseDelayMs: 450 },
      );
      const codeNum = Number(res.code);
      if (!Number.isFinite(codeNum) || codeNum !== 0 || !Array.isArray(res.data?.data)) {
        if (page === 1) {
          throw new Error(`AscendEX funding-rates: code ${String(res.code)}`);
        }
        break;
      }

      const rows = res.data!.data!;
      if (rows.length === 0) break;

      let minTs = Infinity;
      for (const row of rows) {
        const ts = parseAdxFundingTimeMs(row);
        if (ts === null) continue;
        minTs = Math.min(minTs, ts);
        if (ts < sinceMs || ts > untilMs) continue;
        const r = row.fundingRate;
        if (r == null || r === "") continue;
        out.push({
          nativeSymbol,
          fundingTime: new Date(ts),
          rate: String(r),
        });
      }

      if (res.data!.hasNext !== true) break;
      if (Number.isFinite(minTs) && minTs < sinceMs) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const interval = ascendexIntervalStr(intervalMin);
    const url = new URL("https://ascendex.com/api/pro/v1/barhist");
    url.searchParams.set("symbol", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("from", String(range.since.getTime()));
    url.searchParams.set("to", String(range.until.getTime()));

    const res = await fetchWithRetry(
      () => fetchJson<{ code: number; data?: AdxBarRow[] }>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (res.code !== 0 || !Array.isArray(res.data)) return [];

    const out: KlinePoint[] = [];
    for (const wrap of res.data) {
      const d = wrap.data;
      if (!d?.ts) continue;
      const t = d.ts;
      if (t < range.since.getTime() || t > range.until.getTime()) continue;
      const o = Number(d.o);
      const h = Number(d.h);
      const l = Number(d.l);
      const c = Number(d.c);
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
