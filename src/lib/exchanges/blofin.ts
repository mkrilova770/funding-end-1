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

type BloRow = {
  instId: string;
  fundingRate: string;
  fundingTime?: string;
};

type BloResp = { code: string; msg?: string; data?: BloRow[] };

type BloBookResp = {
  code: string;
  msg?: string;
  data?: { asks?: [string, string][]; bids?: [string, string][]; ts?: string }[];
};

type BloHistRow = {
  instId: string;
  fundingRate: string;
  fundingTime: string;
};

function blofinBar(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1H",
    240: "4H",
    480: "8H",
  };
  return m[intervalMin] ?? "4H";
}

export const blofinAdapter: ExchangeFundingAdapter = {
  slug: "blofin" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const res = await fetchWithRetry(
      () =>
        fetchJson<BloResp>(
          "https://openapi.blofin.com/api/v1/market/funding-rate",
        ),
      { retries: 2, baseDelayMs: 400 },
    );
    if (res.code !== "0" || !Array.isArray(res.data)) {
      throw new Error(`BloFin funding-rate: ${res.msg ?? res.code}`);
    }

    const rows = res.data.filter((row) => row.instId?.endsWith("-USDT"));
    const books = await mapLimit(rows, 25, async (row) => {
      const url = `https://openapi.blofin.com/api/v1/market/books?instId=${encodeURIComponent(row.instId)}&sz=1`;
      const b = await fetchWithRetry(
        () => fetchJson<BloBookResp>(url),
        { retries: 1, baseDelayMs: 200 },
      );
      return { row, b };
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { row, b } of books) {
      const base = row.instId.replace(/-USDT$/i, "").toUpperCase();
      if (!base) continue;

      const ftMs = row.fundingTime ? Number(row.fundingTime) : NaN;
      let bestBid: string | undefined;
      let bestAsk: string | undefined;
      let mark: string | undefined;
      if (b.code === "0" && Array.isArray(b.data) && b.data[0]) {
        const d = b.data[0]!;
        const ask0 = d.asks?.[0]?.[0];
        const bid0 = d.bids?.[0]?.[0];
        const a = ask0 != null ? Number(ask0) : NaN;
        const bn = bid0 != null ? Number(bid0) : NaN;
        if (Number.isFinite(a) && Number.isFinite(bn) && a > 0 && bn > 0) {
          bestAsk = String(a);
          bestBid = String(bn);
          mark = String((a + bn) / 2);
        }
      }

      markets.push({
        nativeSymbol: row.instId,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: row.instId,
        rate: String(row.fundingRate),
        nextFundingTime: Number.isFinite(ftMs) ? new Date(ftMs) : null,
        markPrice: mark,
        bestBid: bestBid ?? mark,
        bestAsk: bestAsk ?? mark,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];
    const seen = new Set<number>();
    let afterMs = since - 1;

    for (let page = 0; page < 100; page++) {
      const url = new URL(
        "https://openapi.blofin.com/api/v1/market/funding-rate-history",
      );
      url.searchParams.set("instId", nativeSymbol);
      url.searchParams.set("limit", "100");
      url.searchParams.set("after", String(afterMs));

      const res = await fetchWithRetry(
        () =>
          fetchJson<{ code: string; msg?: string; data?: BloHistRow[] }>(
            url.toString(),
          ),
        { retries: 2, baseDelayMs: 400 },
      );
      if (res.code !== "0" || !Array.isArray(res.data) || res.data.length === 0)
        break;

      let maxT = afterMs;
      for (const row of res.data) {
        const t = Number(row.fundingTime);
        if (!Number.isFinite(t)) continue;
        maxT = Math.max(maxT, t);
        if (t < since || t > until) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({
          nativeSymbol: row.instId ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.fundingRate),
        });
      }

      if (maxT <= afterMs) break;
      afterMs = maxT;
      if (res.data.length < 100) break;
      if (maxT >= until) break;
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const bar = blofinBar(intervalMin);
    const url = new URL("https://openapi.blofin.com/api/v1/market/candles");
    url.searchParams.set("instId", nativeSymbol);
    url.searchParams.set("bar", bar);
    url.searchParams.set("limit", "300");

    const res = await fetchWithRetry(
      () =>
        fetchJson<{
          code: string;
          msg?: string;
          data?: (string | number)[][];
        }>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (res.code !== "0" || !Array.isArray(res.data)) return [];

    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: KlinePoint[] = [];
    for (const row of res.data) {
      const t = Number(row[0]);
      if (!Number.isFinite(t) || t < since || t > until) continue;
      const o = Number(row[1]);
      const h = Number(row[2]);
      const l = Number(row[3]);
      const c = Number(row[4]);
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
