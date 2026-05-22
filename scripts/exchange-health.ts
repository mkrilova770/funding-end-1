/**
 * Одноразовая проверка: снимок «сейчас» + короткая история BTC + klines (если есть).
 * Запуск: npx tsx scripts/exchange-health.ts
 */
import { EXCHANGE_ADAPTERS, ALL_EXCHANGE_SLUGS } from "../src/lib/exchanges";
import type { ExchangeAdapterSlug } from "../src/lib/exchanges/types";

const SNAP_MS = 14_000;
const HIST_MS = 12_000;
const KLINE_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function probe(slug: ExchangeAdapterSlug) {
  const adapter = EXCHANGE_ADAPTERS[slug];
  const snapOk: string[] = [];
  const snapErr: string[] = [];
  const histOk: string[] = [];
  const histErr: string[] = [];
  const klnOk: string[] = [];
  const klnErr: string[] = [];

  try {
    const snap = await withTimeout(adapter.fetchMarketsWithLatest(), SNAP_MS);
    const n = snap.markets.length;
    if (n === 0) snapErr.push("0 markets");
    else snapOk.push(`${n} mkts`);
  } catch (e) {
    snapErr.push(e instanceof Error ? e.message : String(e));
  }

  const supportsHist = adapter.supportsHistory !== false;
  if (!supportsHist) {
    histErr.push("supportsHistory=false");
  } else {
    try {
      let native = "BTCUSDT";
      try {
        const snap = await withTimeout(adapter.fetchMarketsWithLatest(), SNAP_MS);
        const btc = snap.markets.find(
          (m) => m.baseAsset.toUpperCase() === "BTC",
        );
        if (btc) native = btc.nativeSymbol;
      } catch {
        /* use default */
      }
      const until = new Date();
      const since = new Date(until.getTime() - 3 * 24 * 60 * 60 * 1000);
      const pts = await withTimeout(
        adapter.fetchFundingHistory(native, { since, until }),
        HIST_MS,
      );
      if (pts.length === 0) histErr.push("0 points");
      else histOk.push(`${pts.length} pts`);
    } catch (e) {
      histErr.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (!adapter.fetchKlines) {
    klnErr.push("no fetchKlines");
  } else {
    try {
      let native = "BTCUSDT";
      try {
        const snap = await withTimeout(adapter.fetchMarketsWithLatest(), SNAP_MS);
        const btc = snap.markets.find(
          (m) => m.baseAsset.toUpperCase() === "BTC",
        );
        if (btc) native = btc.nativeSymbol;
      } catch {
        /* */
      }
      const until = new Date();
      const since = new Date(until.getTime() - 2 * 24 * 60 * 60 * 1000);
      const kl = await withTimeout(
        adapter.fetchKlines(native, { since, until }, 240),
        KLINE_MS,
      );
      if (kl.length === 0) klnErr.push("0 bars");
      else klnOk.push(`${kl.length} bars`);
    } catch (e) {
      klnErr.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { slug, snapOk, snapErr, histOk, histErr, klnOk, klnErr };
}

async function main() {
  const batch = 5;
  const out: Awaited<ReturnType<typeof probe>>[] = [];
  for (let i = 0; i < ALL_EXCHANGE_SLUGS.length; i += batch) {
    const chunk = ALL_EXCHANGE_SLUGS.slice(i, i + batch);
    const part = await Promise.all(chunk.map((s) => probe(s)));
    out.push(...part);
  }

  for (const r of out) {
    const sSnap = r.snapErr.length ? "FAIL" : "ok ";
    const sHist = r.histErr.length ? "FAIL" : "ok ";
    const sKln = r.klnErr.length ? "FAIL" : "ok ";
    const line = `${r.slug.padEnd(10)} snap ${sSnap} ${[...r.snapOk, ...r.snapErr].join("; ")} | hist ${sHist} ${[...r.histOk, ...r.histErr].join("; ")} | kline ${sKln} ${[...r.klnOk, ...r.klnErr].join("; ")}`;
    console.log(line);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
