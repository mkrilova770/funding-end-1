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

const INFO_URL = "https://api.hyperliquid.xyz/info";

type HlUniverseEntry = {
  name: string;
  szDecimals?: number;
  maxLeverage?: number;
  isDelisted?: boolean;
};

type HlMeta = { universe: HlUniverseEntry[] };

type HlAssetCtx = {
  funding?: string;
  markPx?: string;
  midPx?: string;
  impactPxs?: [string, string];
};

type HlPredictedVenue = [
  string,
  {
    fundingRate: string;
    nextFundingTime: number;
    fundingIntervalHours?: number;
  },
];

type HlFundingHistoryRow = {
  coin: string;
  fundingRate: string;
  premium?: string;
  time: number;
};

type HlCandle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

function hlPost<T>(body: unknown): Promise<T> {
  return fetchJson<T>(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
}

function parseHlPerpMeta(
  row: unknown,
): { nextFundingTime: Date; fundingIntervalHours: number | null } | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const venues = row[1] as unknown;
  if (!Array.isArray(venues)) return null;
  for (const v of venues) {
    if (!Array.isArray(v) || v.length < 2) continue;
    if (v[0] !== "HlPerp") continue;
    const d = v[1] as {
      nextFundingTime?: number;
      fundingIntervalHours?: number;
    };
    if (typeof d?.nextFundingTime !== "number") continue;
    const std = normalizeStandardFundingIntervalHours(
      d.fundingIntervalHours,
    );
    return {
      nextFundingTime: new Date(d.nextFundingTime),
      fundingIntervalHours: std,
    };
  }
  return null;
}

export const hyperliquidAdapter: ExchangeFundingAdapter = {
  slug: "hyperliquid" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const [bundle, predicted] = await Promise.all([
      fetchWithRetry(
        () => hlPost<[HlMeta, HlAssetCtx[]]>({ type: "metaAndAssetCtxs" }),
        { retries: 2, baseDelayMs: 400 },
      ),
      fetchWithRetry(
        () => hlPost<unknown[]>({ type: "predictedFundings" }),
        { retries: 1, baseDelayMs: 400 },
      ).catch(() => [] as unknown[]),
    ]);

    const [meta, ctxs] = bundle;
    const universe = meta?.universe ?? [];
    const predByCoin = new Map<
      string,
      { nextFundingTime: Date; fundingIntervalHours: number | null }
    >();
    for (const row of predicted ?? []) {
      const parsed = parseHlPerpMeta(row);
      if (!parsed) continue;
      const coin = Array.isArray(row) ? String(row[0]) : "";
      if (!coin) continue;
      predByCoin.set(coin, parsed);
    }

    const markets: NormalizedMarket[] = [];
    const latest: LatestFunding[] = [];

    for (let i = 0; i < universe.length; i++) {
      const u = universe[i]!;
      if (u.isDelisted) continue;
      const coin = u.name?.trim();
      if (!coin) continue;
      const ctx = ctxs[i] as HlAssetCtx | undefined;
      if (!ctx?.funding) continue;

      markets.push({
        nativeSymbol: coin,
        baseAsset: coin.toUpperCase(),
        quoteAsset: "USDT",
      });

      const pred = predByCoin.get(coin);
      const impact = ctx.impactPxs;
      latest.push({
        nativeSymbol: coin,
        rate: ctx.funding,
        nextFundingTime: pred?.nextFundingTime ?? null,
        markPrice: ctx.markPx ?? ctx.midPx,
        bestBid: impact?.[0],
        bestAsk: impact?.[1],
        fundingIntervalHours: pred?.fundingIntervalHours ?? null,
      });
    }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const coin = nativeSymbol;
    const since = range.since.getTime();
    const until = range.until.getTime();
    const rows: HlFundingHistoryRow[] = [];
    let cursorStart = since;

    for (let page = 0; page < 200; page++) {
      if (cursorStart > until) break;
      const batch = await fetchWithRetry(
        () =>
          hlPost<HlFundingHistoryRow[]>({
            type: "fundingHistory",
            coin,
            startTime: cursorStart,
            endTime: until,
          }),
        { retries: 2, baseDelayMs: 500 },
      );
      if (!Array.isArray(batch) || batch.length === 0) break;

      rows.push(...batch);

      if (batch.length < 500) break;
      const lastT = batch[batch.length - 1]!.time;
      const nextStart = lastT + 1;
      if (nextStart <= cursorStart) break;
      cursorStart = nextStart;
    }

    return rows
      .filter(
        (r) =>
          typeof r.time === "number" &&
          r.time >= since &&
          r.time <= until &&
          typeof r.fundingRate === "string",
      )
      .map((r) => ({
        nativeSymbol: coin,
        fundingTime: new Date(r.time),
        rate: r.fundingRate,
      }));
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const barMap: Record<number, string> = {
      5: "5m",
      30: "30m",
      60: "1h",
      120: "2h",
      240: "4h",
      480: "8h",
    };
    const interval = barMap[intervalMin] ?? "4h";
    const startMs = range.since.getTime();
    const endMs = range.until.getTime();
    const out: KlinePoint[] = [];
    let cursorStart = startMs;

    for (let page = 0; page < 40; page++) {
      if (cursorStart > endMs) break;
      const batch = await fetchWithRetry(
        () =>
          hlPost<HlCandle[]>({
            type: "candleSnapshot",
            req: {
              coin: nativeSymbol,
              interval,
              startTime: cursorStart,
              endTime: endMs,
            },
          }),
        { retries: 2, baseDelayMs: 400 },
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const c of batch) {
        const t = c.t;
        const close = Number(c.c);
        if (t >= startMs && t <= endMs && Number.isFinite(close)) {
          out.push({ time: t, close });
        }
      }
      if (batch.length < 5000) break;
      const lastT = batch[batch.length - 1]!.t;
      const nextStart = lastT + 1;
      if (nextStart <= cursorStart || nextStart > endMs) break;
      cursorStart = nextStart;
    }

    return out.sort((a, b) => a.time - b.time);
  },
};
