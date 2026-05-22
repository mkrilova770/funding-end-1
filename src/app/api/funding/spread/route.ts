import { NextResponse } from "next/server";
import { ALL_EXCHANGE_SLUGS, EXCHANGE_ADAPTERS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug, KlinePoint } from "@/lib/exchanges/types";
import {
  getCachedBidAsk,
  getCachedLatestFundingRate,
  getCachedMarkPrice,
  getCachedNativeSymbol,
  getLiveFundingTableNow,
} from "@/lib/services/funding-table-live";

export const runtime = "nodejs";

const BASE_RE = /^[A-Z0-9]{1,40}$/;
const VALID_INTERVALS = [5, 30, 60, 240] as const;
type IntervalMin = (typeof VALID_INTERVALS)[number];

const KLINE_CACHE_MS = 10 * 60_000;
const klineCache = new Map<string, { at: number; points: KlinePoint[] }>();

const MAX_DAYS_FOR_INTERVAL: Record<IntervalMin, number> = {
  /** 5м: больше дней — панорама по графику; запрос тяжелее, но укладывается в типичные лимиты kline */
  5: 7,
  30: 14,
  60: 30,
  240: 90,
};

function parseExchange(raw: string | null): ExchangeAdapterSlug | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return ALL_EXCHANGE_SLUGS.find((x) => x === s) ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function getKlinesCached(
  slug: ExchangeAdapterSlug,
  nativeSymbol: string,
  days: number,
  intervalMin: IntervalMin,
): Promise<KlinePoint[]> {
  const key = `${slug}::${nativeSymbol}::${days}::${intervalMin}`;
  const c = klineCache.get(key);
  if (c && Date.now() - c.at < KLINE_CACHE_MS) return c.points;

  const adapter = EXCHANGE_ADAPTERS[slug];
  if (!adapter.fetchKlines) return [];

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const points = await withTimeout(
    adapter.fetchKlines(nativeSymbol, { since, until }, intervalMin),
    30_000,
  );
  klineCache.set(key, { at: Date.now(), points });
  return points;
}

function normalizeKlineTimeMs(t: number): number {
  // Some exchanges may return seconds, others milliseconds.
  return t < 1_000_000_000_000 ? t * 1000 : t;
}

function buildCloseByBucket(
  points: KlinePoint[],
  intervalMs: number,
  nowMs: number,
): Map<number, { time: number; close: number }> {
  const out = new Map<number, { time: number; close: number }>();
  for (const p of points) {
    const t = normalizeKlineTimeMs(p.time);
    const close = Number(p.close);
    if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) continue;
    // Ignore not-yet-closed candle to keep "close" consistent with exchanges.
    if (t + intervalMs > nowMs) continue;
    const bucket = Math.floor(t / intervalMs) * intervalMs;
    const prev = out.get(bucket);
    if (!prev || t > prev.time) out.set(bucket, { time: t, close });
  }
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const exchangeA = parseExchange(url.searchParams.get("exchangeA"));
  const exchangeB = parseExchange(url.searchParams.get("exchangeB"));
  const baseRaw = (url.searchParams.get("base") ?? "").trim().toUpperCase();

  const rawInterval = Number(url.searchParams.get("interval") ?? "240");
  const intervalMin: IntervalMin = VALID_INTERVALS.includes(rawInterval as IntervalMin)
    ? (rawInterval as IntervalMin)
    : 240;

  const maxDays = MAX_DAYS_FOR_INTERVAL[intervalMin];
  const days = Math.min(maxDays, Math.max(1, Number(url.searchParams.get("days") ?? String(maxDays))));

  if (!exchangeA || !exchangeB) {
    return NextResponse.json({ error: "Укажите exchangeA и exchangeB" }, { status: 400 });
  }
  if (!baseRaw || !BASE_RE.test(baseRaw)) {
    return NextResponse.json({ error: "Некорректный параметр base" }, { status: 400 });
  }

  await getLiveFundingTableNow({
    page: 1,
    pageSize: 5,
    visibleExchanges: [exchangeA, exchangeB],
    sortBy: "coins",
    sortDir: "asc",
  });

  const fundingRateA = getCachedLatestFundingRate(exchangeA, baseRaw);
  const fundingRateB = getCachedLatestFundingRate(exchangeB, baseRaw);

  const nsA = getCachedNativeSymbol(exchangeA, baseRaw);
  const nsB = getCachedNativeSymbol(exchangeB, baseRaw);
  if (!nsA || !nsB) {
    return NextResponse.json(
      { error: `Рынок ${baseRaw} не найден на одной из бирж` },
      { status: 404 },
    );
  }

  const baA = getCachedBidAsk(exchangeA, baseRaw);
  const baB = getCachedBidAsk(exchangeB, baseRaw);
  const markA = getCachedMarkPrice(exchangeA, baseRaw);
  const markB = getCachedMarkPrice(exchangeB, baseRaw);

  let currentSpread: {
    askA: number | null;
    bidA: number | null;
    askB: number | null;
    bidB: number | null;
    aToB: {
      entrySpread: number | null;
      exitSpread: number | null;
      netResult: number | null;
    };
    bToA: {
      entrySpread: number | null;
      exitSpread: number | null;
      netResult: number | null;
    };
  } | null = null;

  const pxA = {
    bid: baA?.bid ?? markA ?? null,
    ask: baA?.ask ?? markA ?? null,
  };
  const pxB = {
    bid: baB?.bid ?? markB ?? null,
    ask: baB?.ask ?? markB ?? null,
  };

  if (pxA.bid && pxA.ask && pxB.bid && pxB.ask) {
    const entryAtoB = pxA.ask > 0 ? ((pxB.bid - pxA.ask) / pxA.ask) * 100 : null;
    const exitAtoB = pxA.bid > 0 ? ((pxB.ask - pxA.bid) / pxA.bid) * 100 : null;
    const netAtoB =
      entryAtoB !== null && exitAtoB !== null
        ? entryAtoB - exitAtoB
        : null;

    const entryBtoA = pxB.ask > 0 ? ((pxA.bid - pxB.ask) / pxB.ask) * 100 : null;
    const exitBtoA = pxB.bid > 0 ? ((pxA.ask - pxB.bid) / pxB.bid) * 100 : null;
    const netBtoA =
      entryBtoA !== null && exitBtoA !== null
        ? entryBtoA - exitBtoA
        : null;

    currentSpread = {
      askA: pxA.ask,
      bidA: pxA.bid,
      askB: pxB.ask,
      bidB: pxB.bid,
      aToB: {
        entrySpread: entryAtoB,
        exitSpread: exitAtoB,
        netResult: netAtoB,
      },
      bToA: {
        entrySpread: entryBtoA,
        exitSpread: exitBtoA,
        netResult: netBtoA,
      },
    };
  }

  const adapterA = EXCHANGE_ADAPTERS[exchangeA];
  const adapterB = EXCHANGE_ADAPTERS[exchangeB];
  const supportsA = Boolean(adapterA.fetchKlines);
  const supportsB = Boolean(adapterB.fetchKlines);
  let klineCountA = 0;
  let klineCountB = 0;

  let history: {
    time: number;
    spreadPct: number;
    closeA: number;
    closeB: number;
  }[] = [];

  if (supportsA && supportsB) {
    try {
      const [klinesA, klinesB] = await Promise.all([
        getKlinesCached(exchangeA, nsA, days, intervalMin),
        getKlinesCached(exchangeB, nsB, days, intervalMin),
      ]);
      klineCountA = klinesA.length;
      klineCountB = klinesB.length;

      if (klinesA.length && klinesB.length) {
        const intervalMs = intervalMin * 60 * 1000;
        const nowMs = Date.now();
        const aByBucket = buildCloseByBucket(klinesA, intervalMs, nowMs);
        const bByBucket = buildCloseByBucket(klinesB, intervalMs, nowMs);
        const commonBuckets = [...aByBucket.keys()]
          .filter((b) => bByBucket.has(b))
          .sort((x, y) => x - y);

        for (const bucket of commonBuckets) {
          const a = aByBucket.get(bucket);
          const b = bByBucket.get(bucket);
          if (!a || !b) continue;
          if (a.close === 0 || b.close === 0) continue;
          // Directional entry-like spread for selected side A -> B (long A, short B):
          // negative => worse entry for this direction, positive => better entry.
          history.push({
            time: Math.max(a.time, b.time),
            spreadPct: a.close > 0 ? ((b.close - a.close) / a.close) * 100 : 0,
            closeA: a.close,
            closeB: b.close,
          });
        }
        history.sort((a, b) => a.time - b.time);
      }
    } catch (e) {
      console.error("Kline fetch error:", e);
    }
  }

  return NextResponse.json(
    {
      base: baseRaw,
      exchangeA,
      exchangeB,
      days,
      intervalMin,
      currentFundingRates: {
        rateA: fundingRateA,
        rateB: fundingRateB,
      },
      currentSpread,
      supportsKlinesA: supportsA,
      supportsKlinesB: supportsB,
      klineCountA,
      klineCountB,
      history,
    },
    { headers: { "Cache-Control": "private, max-age=60, s-maxage=120" } },
  );
}
