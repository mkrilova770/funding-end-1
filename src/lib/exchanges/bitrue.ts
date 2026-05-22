import { createHmac } from "node:crypto";
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

type BtrContract = {
  symbol: string;
  multiplierCoin?: string;
};

type BtrIndex = {
  currentFundRate?: number;
  nextFundRate?: number;
  tagPrice?: number;
  indexPrice?: number;
  remainingSecond?: number;
};

type BtrDepth = {
  asks?: [number, number][];
  bids?: [number, number][];
  time?: number;
};

function bitrueInterval(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    480: "8h",
  };
  return m[intervalMin] ?? "4h";
}

function bitrueSortedQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function signBitrueFapiGet(opts: {
  timestampMs: string;
  path: string;
  queryString: string;
  secret: string;
}): string {
  const signPath = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const signMessage = `${opts.timestampMs}GET${signPath}${opts.queryString ? `?${opts.queryString}` : ""}`;
  return createHmac("sha256", opts.secret).update(signMessage).digest("hex");
}

function bitrueFundingHistoryKeys(): { apiKey: string; secret: string } | null {
  const apiKey =
    process.env.BITRUE_FAPI_API_KEY?.trim() ||
    process.env.BITRUE_API_KEY?.trim() ||
    "";
  const secret =
    process.env.BITRUE_FAPI_SECRET?.trim() ||
    process.env.BITRUE_API_SECRET?.trim() ||
    "";
  if (!apiKey || !secret) return null;
  return { apiKey, secret };
}

type BtrHistFundRow = {
  fundingTime?: number | string;
  fTime?: number | string;
  time?: number | string;
  fundingRate?: number | string;
  fundRate?: number | string;
  rate?: number | string;
};

type BtrHistFundResp = {
  code?: number | string;
  msg?: string;
  data?: BtrHistFundRow[] | { list?: BtrHistFundRow[] };
};

function extractBtrHistRows(
  data: BtrHistFundResp["data"],
): BtrHistFundRow[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.list)) return data.list;
  return [];
}

function rowFundingTimeMs(row: BtrHistFundRow): number | null {
  const raw = row.fundingTime ?? row.fTime ?? row.time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

function rowFundingRateStr(row: BtrHistFundRow): string | null {
  const r = row.fundingRate ?? row.fundRate ?? row.rate;
  if (r === undefined || r === null) return null;
  const s = typeof r === "number" ? String(r) : String(r).trim();
  return s === "" ? null : s;
}

export const bitrueAdapter: ExchangeFundingAdapter = {
  slug: "bitrue" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const raw = await fetchWithRetry(
      () => fetchJson<unknown>("https://fapi.bitrue.com/fapi/v1/contracts"),
      { retries: 2, baseDelayMs: 400 },
    );
    const contracts = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as { data?: unknown }).data)
        ? ((raw as { data: BtrContract[] }).data as BtrContract[])
        : null;
    if (!Array.isArray(contracts) || contracts.length === 0) {
      throw new Error("Bitrue contracts: expected non-empty array");
    }

    type RowOk = {
      ok: true;
      c: BtrContract;
      idx: BtrIndex | { code?: string; msg?: string };
      dep: BtrDepth;
    };
    type RowPack = RowOk | { ok: false };

    const rows: RowPack[] = await mapLimit(contracts, 28, async (c): Promise<RowPack> => {
      if (!c.symbol?.endsWith("-USDT")) return { ok: false };
      const q = encodeURIComponent(c.symbol);
      try {
        const idx = await fetchWithRetry(
          () =>
            fetchJson<BtrIndex | { code?: string; msg?: string }>(
              `https://fapi.bitrue.com/fapi/v1/index?contractName=${q}`,
            ),
          { retries: 1, baseDelayMs: 250 },
        );
        let dep: BtrDepth = {};
        try {
          dep = await fetchWithRetry(
            () =>
              fetchJson<BtrDepth>(
                `https://fapi.bitrue.com/fapi/v1/depth?contractName=${q}&limit=5`,
              ),
            { retries: 0, baseDelayMs: 120 },
          );
        } catch {
          /* стакан не обязателен — mark/bid-ask из index */
        }
        return { ok: true, c, idx, dep };
      } catch {
        return { ok: false };
      }
    });

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const row of rows) {
      if (!row.ok) continue;
      const { c, idx, dep } = row;
      if (!c.symbol?.endsWith("-USDT")) continue;
      const ix = idx as BtrIndex & { code?: string };
      if (ix.code !== undefined && String(ix.code) !== "0") continue;
      if (ix.currentFundRate === undefined && ix.nextFundRate === undefined) {
        continue;
      }
      const coin = c.multiplierCoin?.toUpperCase();
      const base =
        coin ||
        c.symbol.replace(/^E-/i, "").replace(/-USDT$/i, "").toUpperCase();
      if (!base) continue;

      const rate =
        ix.nextFundRate !== undefined
          ? ix.nextFundRate
          : ix.currentFundRate!;
      const tag = ix.tagPrice ?? ix.indexPrice;
      const lp = tag != null ? String(tag) : undefined;
      const nextMs =
        ix.remainingSecond != null
          ? Date.now() + ix.remainingSecond * 1000
          : NaN;

      let bestBid = lp;
      let bestAsk = lp;
      const bid0 = dep.bids?.[0]?.[0];
      const ask0 = dep.asks?.[0]?.[0];
      const b = bid0 != null ? Number(bid0) : NaN;
      const a = ask0 != null ? Number(ask0) : NaN;
      if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
        bestBid = String(b);
        bestAsk = String(a);
      }

      markets.push({
        nativeSymbol: c.symbol,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: c.symbol,
        rate: String(rate),
        nextFundingTime: Number.isFinite(nextMs) ? new Date(nextMs) : null,
        markPrice: lp,
        bestBid,
        bestAsk,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const keys = bitrueFundingHistoryKeys();
    if (!keys) return [];
    try {
      const sinceMs = range.since.getTime();
      const untilMs = range.until.getTime() + 60 * 60 * 1000;
      const out: FundingHistoryPoint[] = [];
      const seen = new Set<number>();
      const signPath = "/fapi/v1/historyFundingRate";
      const limit = 100;
      /** Bitrue: в доке FAPI времена в миллисекундах (в отличие от klines со секундами). */
      let endTimeMs = Math.floor(untilMs);
      const maxPages = 60;

      let serverOffsetMs = 0;
      try {
        const t = await fetchWithRetry(
          () =>
            fetchJson<{ serverTime?: number }>(
              "https://fapi.bitrue.com/fapi/v1/time",
            ),
          { retries: 1, baseDelayMs: 200 },
        );
        if (typeof t.serverTime === "number" && Number.isFinite(t.serverTime)) {
          serverOffsetMs = t.serverTime - Date.now();
        }
      } catch {
        /* optional */
      }

      for (let page = 0; page < maxPages; page++) {
        const ts = String(Date.now() + serverOffsetMs);
        const queryParams: Record<string, string> = {
          contractName: nativeSymbol,
          endTime: String(endTimeMs),
          limit: String(limit),
        };
        const queryString = bitrueSortedQueryString(queryParams);
        const sign = signBitrueFapiGet({
          timestampMs: ts,
          path: signPath,
          queryString,
          secret: keys.secret,
        });

        const url = `https://fapi.bitrue.com${signPath}?${queryString}`;

        const res = await fetchWithRetry(
          () =>
            fetchJson<BtrHistFundResp>(url, {
              headers: {
                "X-CH-APIKEY": keys.apiKey,
                "X-CH-SIGN": sign,
                "X-CH-TS": ts,
              },
            }),
          { retries: 2, baseDelayMs: 450 },
        );

        const code = res.code;
        if (code !== 0 && code !== "0" && code !== "200" && code !== 200) {
          throw new Error(
            `Bitrue historyFundingRate: ${String(code)} ${res.msg ?? ""}`,
          );
        }

        const rows = extractBtrHistRows(res.data);
        if (rows.length === 0) break;

        let minTs = Infinity;
        for (const row of rows) {
          const tms = rowFundingTimeMs(row);
          if (tms === null) continue;
          minTs = Math.min(minTs, tms);
          if (tms < sinceMs || tms > untilMs) continue;
          const rateStr = rowFundingRateStr(row);
          if (rateStr === null) continue;
          if (seen.has(tms)) continue;
          seen.add(tms);
          out.push({
            nativeSymbol,
            fundingTime: new Date(tms),
            rate: rateStr,
          });
        }

        if (!Number.isFinite(minTs)) break;
        if (minTs <= sinceMs || rows.length < limit) break;
        const nextEndMs = minTs - 1;
        if (nextEndMs >= endTimeMs) break;
        endTimeMs = nextEndMs;
      }

      return out;
    } catch {
      return [];
    }
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const interval = bitrueInterval(intervalMin);
    const url = new URL("https://fapi.bitrue.com/fapi/v1/klines");
    url.searchParams.set("contractName", nativeSymbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set(
      "startTime",
      String(Math.floor(range.since.getTime() / 1000)),
    );
    url.searchParams.set(
      "endTime",
      String(Math.floor(range.until.getTime() / 1000)),
    );

    const raw = await fetchWithRetry(
      () => fetchJson<unknown>(url.toString()),
      { retries: 2, baseDelayMs: 450 },
    );
    if (!Array.isArray(raw)) return [];

    const out: KlinePoint[] = [];
    for (const row of raw as {
      idx?: number;
      open?: number;
      high?: number;
      low?: number;
      close?: number;
    }[]) {
      const t = row.idx != null ? Number(row.idx) : NaN;
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
