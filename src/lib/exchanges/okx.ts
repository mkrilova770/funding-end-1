import { fetchJson, fetchWithRetry } from "@/lib/http/fetchJson";
import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  KlinePoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

type OkxResp<T> = { code: string; msg: string; data: T };

type OkxInstrument = {
  instId: string;
  instType: string;
  settleCcy?: string;
  state: string;
};

type OkxFundingRate = {
  instId: string;
  fundingRate: string;
  nextFundingTime?: string;
  fundingTime?: string;
};

function baseFromInstId(instId: string): string | null {
  if (!instId.endsWith("-USDT-SWAP")) return null;
  const base = instId.slice(0, -"-USDT-SWAP".length);
  return base ? base.toUpperCase() : null;
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R | null>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      worker(),
    ),
  );
  return results;
}

export const okxAdapter: ExchangeFundingAdapter = {
  slug: "okx" as ExchangeAdapterSlug,

  async fetchMarketsWithLatest() {
    const instUrl =
      "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
    const instRes = await fetchWithRetry(
      () => fetchJson<OkxResp<OkxInstrument[]>>(instUrl),
      { retries: 2, baseDelayMs: 400 },
    );
    if (instRes.code !== "0") {
      throw new Error(`OKX instruments: ${instRes.msg}`);
    }

    const instIds = (instRes.data ?? [])
      .filter(
        (i) =>
          i.state === "live" &&
          i.settleCcy === "USDT" &&
          i.instId.endsWith("-USDT-SWAP"),
      )
      .map((i) => i.instId);

    const markets: NormalizedMarket[] = instIds.map((id) => ({
      nativeSymbol: id,
      baseAsset: baseFromInstId(id) ?? id,
      quoteAsset: "USDT",
    }));

    /**
     * OKX принимает ровно один `instId` за запрос; несколько instId → code 51000 и пустой data.
     * @see https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate
     */
    const latestChunks = await mapLimit(instIds, 20, async (instId) => {
      const url = new URL("https://www.okx.com/api/v5/public/funding-rate");
      url.searchParams.set("instType", "SWAP");
      url.searchParams.set("instId", instId);
      try {
        const fr = await fetchWithRetry(
          () =>
            fetchJson<OkxResp<OkxFundingRate[]>>(url.toString(), {
              timeoutMs: 10_000,
            }),
          { retries: 1, baseDelayMs: 350 },
        );
        if (fr.code !== "0" || !fr.data?.[0]) return null;
        const row = fr.data[0];
        return {
          nativeSymbol: row.instId,
          rate: row.fundingRate,
          nextFundingTime: row.nextFundingTime
            ? new Date(Number(row.nextFundingTime))
            : null,
        } satisfies LatestFunding;
      } catch {
        return null;
      }
    });

    const latest = latestChunks.filter(Boolean) as LatestFunding[];

    try {
      const mpRes = await fetchWithRetry(
        () =>
          fetchJson<
            OkxResp<{ instId: string; markPx: string }[]>
          >("https://www.okx.com/api/v5/public/mark-price?instType=SWAP"),
        { retries: 1, baseDelayMs: 300 },
      );
      if (mpRes.code === "0" && mpRes.data) {
        const mpMap = new Map(mpRes.data.map((r) => [r.instId, r.markPx]));
        for (const l of latest) {
          const mp = mpMap.get(l.nativeSymbol);
          if (mp) l.markPrice = mp;
        }
      }
    } catch { /* mark-price is optional */ }

    try {
      const tickerRes = await fetchWithRetry(
        () =>
          fetchJson<
            OkxResp<{ instId: string; bidPx: string; askPx: string }[]>
          >("https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
        { retries: 1, baseDelayMs: 300 },
      );
      if (tickerRes.code === "0" && tickerRes.data) {
        const baMap = new Map(
          tickerRes.data.map((r) => [r.instId, { bid: r.bidPx, ask: r.askPx }]),
        );
        for (const l of latest) {
          const ba = baMap.get(l.nativeSymbol);
          if (ba) {
            l.bestBid = ba.bid;
            l.bestAsk = ba.ask;
          }
        }
      }
    } catch { /* ticker bid/ask is optional */ }

    return { markets, latest };
  },

  async fetchFundingHistory(nativeSymbol, range) {
    const out: FundingHistoryPoint[] = [];
    let before: string | undefined = undefined;

    for (let i = 0; i < 200; i++) {
      const url = new URL(
        "https://www.okx.com/api/v5/public/funding-rate-history",
      );
      url.searchParams.set("instId", nativeSymbol);
      url.searchParams.set("limit", "100");
      if (before) url.searchParams.set("before", before);

      const data = await fetchWithRetry(
        () => fetchJson<OkxResp<OkxFundingRate[]>>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.code !== "0") {
        throw new Error(`OKX funding history: ${data.msg}`);
      }
      const list = data.data ?? [];
      if (list.length === 0) break;

      for (const row of list) {
        if (!row.fundingTime) continue;
        const t = new Date(Number(row.fundingTime));
        out.push({
          nativeSymbol: row.instId,
          fundingTime: t,
          rate: row.fundingRate,
        });
      }

      const oldest = list[list.length - 1];
      if (!oldest?.fundingTime) break;
      const nextBefore = oldest.fundingTime;
      if (before === nextBefore) break;
      before = nextBefore;

      const oldestMs = Number(oldest.fundingTime);
      if (oldestMs < range.since.getTime()) break;
      if (list.length < 100) break;
    }

    return out.filter(
      (p) =>
        p.fundingTime.getTime() >= range.since.getTime() &&
        p.fundingTime.getTime() <= range.until.getTime(),
    );
  },

  async fetchKlines(nativeSymbol, range, intervalMin = 240) {
    const barMap: Record<number, string> = { 5: "5m", 30: "30m", 60: "1H", 240: "4H", 480: "8H" };
    const bar = barMap[intervalMin] ?? "4H";
    const out: KlinePoint[] = [];
    let afterTs = String(range.until.getTime());
    const startMs = range.since.getTime();

    for (let page = 0; page < 20; page++) {
      const url = new URL("https://www.okx.com/api/v5/market/candles");
      url.searchParams.set("instId", nativeSymbol);
      url.searchParams.set("bar", bar);
      url.searchParams.set("after", afterTs);
      url.searchParams.set("limit", "300");

      const data = await fetchWithRetry(
        () => fetchJson<OkxResp<string[][]>>(url.toString()),
        { retries: 2, baseDelayMs: 500 },
      );
      if (data.code !== "0" || !data.data?.length) break;

      for (const r of data.data) {
        const t = Number(r[0]);
        if (t >= startMs) out.push({ time: t, close: Number(r[4]) });
      }

      const times = data.data.map((r) => Number(r[0]));
      const minTime = Math.min(...times);
      if (minTime <= startMs) break;
      afterTs = String(minTime);
      if (data.data.length < 300) break;
    }

    return out.sort((a, b) => a.time - b.time);
  },
};
