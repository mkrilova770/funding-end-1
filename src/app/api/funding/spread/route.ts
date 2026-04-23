import { NextResponse } from "next/server";
import { ALL_EXCHANGE_SLUGS, EXCHANGE_ADAPTERS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug, KlinePoint } from "@/lib/exchanges/types";
import {
  getCachedBidAsk,
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
  5: 3,
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

function findCloseB(
  mapB: Map<number, number>,
  timeA: number,
  intervalMs: number,
): number | undefined {
  let cb = mapB.get(timeA);
  if (cb !== undefined) return cb;
  const rounded = Math.round(timeA / intervalMs) * intervalMs;
  cb = mapB.get(rounded);
  if (cb !== undefined) return cb;
  for (const [t, c] of mapB) {
    if (Math.abs(t - timeA) < intervalMs * 0.6) return c;
  }
  return undefined;
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
    sortBy: "base",
    sortDir: "asc",
  });

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

  let currentSpread: {
    askA: number | null;
    bidA: number | null;
    askB: number | null;
    bidB: number | null;
    entryAtoB: number | null;
    entryBtoA: number | null;
  } | null = null;

  if (baA && baB) {
    currentSpread = {
      askA: baA.ask,
      bidA: baA.bid,
      askB: baB.ask,
      bidB: baB.bid,
      entryAtoB: baA.ask > 0 ? ((baB.bid - baA.ask) / baA.ask) * 100 : null,
      entryBtoA: baB.ask > 0 ? ((baA.bid - baB.ask) / baB.ask) * 100 : null,
    };
  }

  const adapterA = EXCHANGE_ADAPTERS[exchangeA];
  const adapterB = EXCHANGE_ADAPTERS[exchangeB];
  const supportsA = Boolean(adapterA.fetchKlines);
  const supportsB = Boolean(adapterB.fetchKlines);

  let history: { time: number; spreadPct: number }[] = [];

  if (supportsA && supportsB) {
    try {
      const [klinesA, klinesB] = await Promise.all([
        getKlinesCached(exchangeA, nsA, days, intervalMin),
        getKlinesCached(exchangeB, nsB, days, intervalMin),
      ]);

      if (klinesA.length && klinesB.length) {
        const mapB = new Map<number, number>();
        for (const k of klinesB) mapB.set(k.time, k.close);

        const intervalMs = intervalMin * 60 * 1000;
        for (const ka of klinesA) {
          const cb = findCloseB(mapB, ka.time, intervalMs);
          if (cb === undefined || cb === 0 || ka.close === 0) continue;
          history.push({
            time: ka.time,
            spreadPct: ((ka.close - cb) / cb) * 100,
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
      currentSpread,
      supportsKlinesA: supportsA,
      supportsKlinesB: supportsB,
      history,
    },
    { headers: { "Cache-Control": "private, max-age=60, s-maxage=120" } },
  );
}
