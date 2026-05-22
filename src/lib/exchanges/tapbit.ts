import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

const TAPBIT_BASE = "https://openapi.tapbit.com/swap";

/** Tapbit/CDN часто отвечает 403 на не-браузерный User-Agent. */
const TAPBIT_HEADERS: HeadersInit = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function tapbitFetchInit(extra?: RequestInit): RequestInit {
  return {
    ...extra,
    headers: {
      ...TAPBIT_HEADERS,
      ...(extra?.headers as Record<string, string> | undefined),
    },
  };
}

function tapbitOk(code: unknown): boolean {
  const n = Number(code);
  return n === 200 || n === 0;
}

type TapTicker = {
  contract_code: string;
  funding_rate?: string;
  last_price?: string;
  mark_price?: string;
  lowest_ask_price?: string;
  highest_bid_price?: string;
};

type TapTickerListResp = {
  code: number;
  message?: string | null;
  data?: TapTicker[];
};

type TapFundResp = {
  code: number;
  message?: string | null;
  data?: { funding_rate?: string };
};

type TapHistFundRow = {
  funding_rate?: string;
  settle_time?: string | number;
  ts?: string | number;
};

type TapHistFundResp = {
  code: number;
  message?: string | null;
  data?: TapHistFundRow[];
};

type TapKlineRow = {
  id?: string | number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  /** ms */
  time?: string | number;
};

type TapKlineResp = {
  code: number;
  message?: string | null;
  data?: TapKlineRow[];
};

function instrumentFromContractCode(code: string): string | null {
  const t = code.trim();
  const swap = /^(.+)-SWAP$/i.exec(t);
  if (swap) return swap[1]!.toUpperCase();
  const usdt = /^(.+?)USDT$/i.exec(t);
  if (usdt && usdt[1]!.length >= 1) return usdt[1]!.toUpperCase();
  return null;
}

function normalizeTapTickerList(data: unknown): TapTicker[] {
  if (Array.isArray(data)) return data as TapTicker[];
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["list", "rows", "tickers", "items"] as const) {
      const v = o[k];
      if (Array.isArray(v)) return v as TapTicker[];
    }
  }
  return [];
}

function fundingRateFromTickerRow(row: TapTicker): string | undefined {
  const raw = row.funding_rate;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}

function tapbitPeriod(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5m",
    30: "30m",
    60: "1h",
    240: "4h",
    480: "8h",
  };
  return m[intervalMin] ?? "4h";
}

export const tapbitAdapter: ExchangeFundingAdapter = {
  slug: "tapbit" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const listUrl = `${TAPBIT_BASE}/api/usdt/instruments/ticker_list`;
    const list = await fetchWithRetry(
      () => fetchJson<TapTickerListResp>(listUrl, tapbitFetchInit()),
      { retries: 2, baseDelayMs: 500 },
    );
    const rows = normalizeTapTickerList(list.data);
    if (!tapbitOk(list.code) || rows.length === 0) {
      throw new Error(`Tapbit ticker_list: ${list.message ?? list.code}`);
    }

    const withInst = rows
      .map((row) => {
        const inst = instrumentFromContractCode(row.contract_code);
        return inst ? { row, inst } : null;
      })
      .filter(Boolean) as { row: TapTicker; inst: string }[];

    /**
     * Лимит ~3 вызова/с: пачки по 2 параллельно, пауза между пачками (быстрее, чем строго по одному).
     */
    const FUNDING_BATCH = 2;
    const INTER_BATCH_MS = 750;

    const funded: {
      row: TapTicker;
      inst: string;
      fr: TapFundResp | null;
      rateFromTicker?: string;
    }[] = [];

    const needFundingApi: { row: TapTicker; inst: string }[] = [];
    for (const { row, inst } of withInst) {
      const fromTicker = fundingRateFromTickerRow(row);
      if (fromTicker !== undefined) {
        funded.push({ row, inst, fr: null, rateFromTicker: fromTicker });
      } else {
        needFundingApi.push({ row, inst });
      }
    }

    for (let i = 0; i < needFundingApi.length; i += FUNDING_BATCH) {
      const slice = needFundingApi.slice(i, i + FUNDING_BATCH);
      const batch = await Promise.all(
        slice.map(async ({ row, inst }) => {
          const url = `${TAPBIT_BASE}/api/usdt/instruments/funding_rate?instrument_id=${encodeURIComponent(inst)}`;
          let fr: TapFundResp;
          try {
            fr = await fetchWithRetry(
              () => fetchJson<TapFundResp>(url, tapbitFetchInit()),
              { retries: 2, baseDelayMs: 400 },
            );
          } catch {
            fr = { code: -1, message: "fetch failed" };
          }
          return { row, inst, fr };
        }),
      );
      for (const { row, inst, fr } of batch) {
        funded.push({ row, inst, fr });
      }
      if (i + FUNDING_BATCH < needFundingApi.length) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
      }
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const { row, inst, fr, rateFromTicker } of funded) {
      let rateStr: string | undefined = rateFromTicker;
      if (rateStr === undefined && fr && tapbitOk(fr.code)) {
        const frd = fr.data?.funding_rate;
        if (frd !== undefined && frd !== null) rateStr = String(frd);
      }
      if (rateStr === undefined) continue;

      const native = row.contract_code;
      const base = inst;
      const mp = row.mark_price ?? row.last_price;
      const bid = row.highest_bid_price ?? mp;
      const ask = row.lowest_ask_price ?? mp;

      markets.push({
        nativeSymbol: native,
        baseAsset: base,
        quoteAsset: "USDT",
      });
      latest.push({
        nativeSymbol: native,
        rate: rateStr,
        nextFundingTime: null,
        markPrice: mp != null ? String(mp) : undefined,
        bestBid: bid != null ? String(bid) : undefined,
        bestAsk: ask != null ? String(ask) : undefined,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const inst = instrumentFromContractCode(nativeSymbol);
    if (!inst) return [];

    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];

    let res: TapHistFundResp;
    try {
      const url = new URL(
        `${TAPBIT_BASE}/api/usdt/instruments/history_funding_rate`,
      );
      url.searchParams.set("instrument_id", inst);
      url.searchParams.set("limit", "200");
      res = await fetchWithRetry(
        () => fetchJson<TapHistFundResp>(url.toString(), tapbitFetchInit()),
        { retries: 1, baseDelayMs: 450 },
      );
    } catch {
      return [];
    }
    if (!tapbitOk(res.code) || !Array.isArray(res.data)) return [];

    for (const row of res.data) {
      const rawT = row.settle_time ?? row.ts;
      if (rawT === undefined) continue;
      const t = typeof rawT === "string" ? Number(rawT) : rawT;
      if (!Number.isFinite(t)) continue;
      const ms: number = t < 1e12 ? t * 1000 : t;
      if (ms < since || ms > until) continue;
      if (row.funding_rate === undefined) continue;
      out.push({
        nativeSymbol,
        fundingTime: new Date(ms),
        rate: String(row.funding_rate),
      });
    }

    out.sort((a, b) => a.fundingTime.getTime() - b.fundingTime.getTime());
    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const inst = instrumentFromContractCode(nativeSymbol);
    if (!inst) return [];

    const period = tapbitPeriod(intervalMin);
    let res: TapKlineResp;
    try {
      const url = new URL(`${TAPBIT_BASE}/api/usdt/market/history/kline`);
      url.searchParams.set("instrument_id", inst);
      url.searchParams.set("period", period);
      url.searchParams.set("limit", "500");
      url.searchParams.set("start_time", String(range.since.getTime()));
      url.searchParams.set("end_time", String(range.until.getTime()));
      res = await fetchWithRetry(
        () => fetchJson<TapKlineResp>(url.toString(), tapbitFetchInit()),
        { retries: 1, baseDelayMs: 450 },
      );
    } catch {
      return [];
    }
    if (!tapbitOk(res.code) || !Array.isArray(res.data)) return [];

    const out: KlinePoint[] = [];
    for (const row of res.data) {
      const rawT = row.time ?? row.id;
      if (rawT === undefined) continue;
      const t = typeof rawT === "string" ? Number(rawT) : Number(rawT);
      if (!Number.isFinite(t)) continue;
      const ms: number = t < 1e12 ? t * 1000 : t;
      if (ms < range.since.getTime() || ms > range.until.getTime()) continue;
      const o = Number(row.open);
      const h = Number(row.high);
      const l = Number(row.low);
      const c = Number(row.close);
      if (!Number.isFinite(c)) continue;
      out.push({
        time: ms,
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
