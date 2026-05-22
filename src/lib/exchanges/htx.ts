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

type HtxContract = {
  symbol: string;
  contract_code: string;
  contract_status: number;
  trade_partition?: string;
  /** Часы между начислениями («1», «4», «8»). */
  settlement_period?: string;
};

type HtxContractInfoResp = { status: string; data: HtxContract[] };

type HtxFundingRow = {
  contract_code: string;
  funding_rate: string;
  funding_time?: string;
  next_funding_time?: string | null;
};

type HtxFundingBatchResp = { status: string; data: HtxFundingRow[] };

/** Лучший bid/ask по контракту — один запрос на все пары (linear-swap-ex). */
type HtxMergedTick = {
  contract_code: string;
  bid: [number | string, number] | null;
  ask: [number | string, number] | null;
  close?: string | number;
};

type HtxMergedResp = { status: string; ticks?: HtxMergedTick[] };

const HTX_BATCH_MERGED_URL =
  "https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged";

type HtxHistRow = {
  contract_code: string;
  funding_rate: string;
  funding_time: string;
};

type HtxHistResp = {
  status: string;
  err_code?: number;
  err_msg?: string;
  data?: {
    data: HtxHistRow[];
    total_page: number;
    current_page: number;
    total_size: number;
  };
};

const HTX_HIST_URL =
  "https://api.hbdm.com/linear-swap-api/v1/swap_historical_funding_rate";

const HTX_KLINE_URL =
  "https://api.hbdm.com/linear-swap-ex/market/history/kline";

type HtxKlineRow = {
  id: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type HtxKlineResp = {
  status: string;
  data?: HtxKlineRow[];
  err_msg?: string;
  "err-msg"?: string;
  err_code?: number;
  "err-code"?: string;
};

function htxKlinePeriod(intervalMin: number): string {
  const m: Record<number, string> = {
    5: "5min",
    30: "30min",
    60: "60min",
    240: "4hour",
    480: "8hour",
  };
  return m[intervalMin] ?? "4hour";
}

function htxKlineErrMsg(res: HtxKlineResp): string {
  const msg = res["err-msg"] ?? res.err_msg;
  const code = res["err-code"] ?? res.err_code;
  return String(msg ?? code ?? res.status);
}

export const htxAdapter: ExchangeFundingAdapter = {
  slug: "htx" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const [info, fr, merged] = await Promise.all([
      fetchWithRetry(
        () =>
          fetchJson<HtxContractInfoResp>(
            "https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?business_type=all",
          ),
        { retries: 2, baseDelayMs: 400 },
      ),
      fetchWithRetry(
        () =>
          fetchJson<HtxFundingBatchResp>(
            "https://api.hbdm.com/linear-swap-api/v1/swap_batch_funding_rate",
          ),
        { retries: 2, baseDelayMs: 400 },
      ),
      fetchWithRetry(
        () => fetchJson<HtxMergedResp>(HTX_BATCH_MERGED_URL),
        { retries: 2, baseDelayMs: 400 },
      ),
    ]);

    if (info.status !== "ok" || !Array.isArray(info.data)) {
      throw new Error(`HTX contract_info: ${info.status}`);
    }
    if (fr.status !== "ok" || !Array.isArray(fr.data)) {
      throw new Error(`HTX funding: ${fr.status}`);
    }

    const mergedByCode = new Map<string, HtxMergedTick>();
    if (merged.status === "ok" && Array.isArray(merged.ticks)) {
      for (const t of merged.ticks) {
        if (t.contract_code) mergedByCode.set(t.contract_code, t);
      }
    }

    const rateByCode = new Map<string, HtxFundingRow>();
    for (const row of fr.data) {
      rateByCode.set(row.contract_code, row);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (const c of info.data) {
      if (c.contract_status !== 1) continue;
      if (!c.contract_code?.endsWith("-USDT")) continue;
      const frRow = rateByCode.get(c.contract_code);
      if (!frRow?.funding_rate) continue;

      const base = c.symbol?.toUpperCase() || c.contract_code.replace(/-USDT$/i, "");
      markets.push({
        nativeSymbol: c.contract_code,
        baseAsset: base,
        quoteAsset: "USDT",
      });

      const nextMs = frRow.next_funding_time
        ? Number(frRow.next_funding_time)
        : NaN;
      const nextFundingTime = Number.isFinite(nextMs)
        ? new Date(nextMs)
        : null;

      const book = mergedByCode.get(c.contract_code);
      let bestBid: string | undefined;
      let bestAsk: string | undefined;
      if (book?.bid?.[0] != null && book?.ask?.[0] != null) {
        const bidN = Number(book.bid[0]);
        const askN = Number(book.ask[0]);
        if (
          Number.isFinite(bidN) &&
          Number.isFinite(askN) &&
          bidN > 0 &&
          askN > 0
        ) {
          bestBid = String(bidN);
          bestAsk = String(askN);
        }
      }
      const mark =
        book?.close != null && String(book.close).length > 0
          ? String(book.close)
          : undefined;

      let fundingIntervalHours: number | null = null;
      const periodH = Number(c.settlement_period);
      if (Number.isFinite(periodH) && periodH > 0) {
        fundingIntervalHours =
          normalizeStandardFundingIntervalHours(periodH);
      } else if (frRow.next_funding_time && frRow.funding_time) {
        const spanMs =
          Number(frRow.next_funding_time) - Number(frRow.funding_time);
        if (Number.isFinite(spanMs) && spanMs > 0) {
          fundingIntervalHours = normalizeStandardFundingIntervalHours(
            spanMs / 3_600_000,
          );
        }
      }

      latest.push({
        nativeSymbol: c.contract_code,
        rate: String(frRow.funding_rate),
        nextFundingTime,
        markPrice: mark,
        bestBid,
        bestAsk,
        fundingIntervalHours,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const since = range.since.getTime();
    const until = range.until.getTime();
    const out: FundingHistoryPoint[] = [];
    const pageSize = 100;

    for (let page = 1; page <= 200; page++) {
      const url = new URL(HTX_HIST_URL);
      url.searchParams.set("contract_code", nativeSymbol);
      url.searchParams.set("page_index", String(page));
      url.searchParams.set("page_size", String(pageSize));

      const res = await fetchWithRetry(
        () => fetchJson<HtxHistResp>(url.toString()),
        { retries: 2, baseDelayMs: 450 },
      );

      if (res.status !== "ok") {
        throw new Error(
          `HTX historical funding: ${res.err_msg ?? res.err_code ?? res.status}`,
        );
      }

      const rows = res.data?.data ?? [];
      if (rows.length === 0) break;

      let oldestMs = Infinity;
      for (const row of rows) {
        const t = Number(row.funding_time);
        if (!Number.isFinite(t)) continue;
        oldestMs = Math.min(oldestMs, t);
        if (t < since || t > until) continue;
        out.push({
          nativeSymbol: row.contract_code ?? nativeSymbol,
          fundingTime: new Date(t),
          rate: String(row.funding_rate),
        });
      }

      if (oldestMs < since) break;
      const totalPage = res.data?.total_page ?? page;
      if (page >= totalPage) break;
    }

    return out;
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const period = htxKlinePeriod(intervalMin);
    const stepSec = Math.max(60, intervalMin * 60);
    /** Слишком широкий from–to возвращает bad-request; куски ~45 суток стабильны */
    const chunkSec = 45 * 24 * 3600;

    const startMs = range.since.getTime();
    const endMs = range.until.getTime();
    let fromSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);

    const byTime = new Map<number, KlinePoint>();

    for (let guard = 0; guard < 500 && fromSec < endSec; guard++) {
      const toSec = Math.min(fromSec + chunkSec, endSec);
      const url = new URL(HTX_KLINE_URL);
      url.searchParams.set("contract_code", nativeSymbol);
      url.searchParams.set("period", period);
      url.searchParams.set("from", String(fromSec));
      url.searchParams.set("to", String(toSec));

      const res = await fetchWithRetry(
        () => fetchJson<HtxKlineResp>(url.toString()),
        { retries: 2, baseDelayMs: 450 },
      );

      if (res.status !== "ok") {
        throw new Error(`HTX klines: ${htxKlineErrMsg(res)}`);
      }

      const rows = res.data ?? [];
      if (rows.length === 0) {
        fromSec = toSec + 1;
        continue;
      }

      for (const row of rows) {
        const tMs = row.id * 1000;
        if (tMs < startMs || tMs > endMs) continue;
        const c = row.close;
        if (!Number.isFinite(c)) continue;
        byTime.set(tMs, {
          time: tMs,
          open: row.open,
          high: row.high,
          low: row.low,
          close: c,
        });
      }

      const lastId = rows[rows.length - 1]!.id;
      const nextFrom = lastId + stepSec;
      if (nextFrom <= fromSec) {
        fromSec = toSec + 1;
      } else {
        fromSec = nextFrom;
      }
    }

    return [...byTime.keys()]
      .sort((a, b) => a - b)
      .map((k) => byTime.get(k)!);
  },
};
