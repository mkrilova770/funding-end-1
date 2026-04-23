import { Prisma, type PrismaClient } from "@prisma/client";
import { EXCHANGE_ADAPTERS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";

const HISTORY_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;
const HISTORY_SLICE = 90;
/** SQLite ограничивает число параметров в одном INSERT — вставляем чанками. */
const HISTORY_INSERT_CHUNK = 80;

function decimalRate(rate: string): Prisma.Decimal {
  return new Prisma.Decimal(rate);
}

export async function runFundingSync(client: PrismaClient): Promise<void> {
  const run = await client.syncRun.create({
    data: { status: "running" },
  });

  let partial = false;

  try {
    const exchanges = await client.exchange.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: "asc" },
    });

    for (const ex of exchanges) {
      const slug = ex.slug as ExchangeAdapterSlug;
      const adapter = EXCHANGE_ADAPTERS[slug];
      const t0 = Date.now();

      if (!adapter) {
        partial = true;
        await client.adapterLog.create({
          data: {
            syncRunId: run.id,
            exchangeId: ex.id,
            status: "skipped",
            message: "Адаптер не зарегистрирован",
            durationMs: Date.now() - t0,
          },
        });
        continue;
      }

      try {
        const snapshot = await adapter.fetchMarketsWithLatest();

        for (const m of snapshot.markets) {
          await client.market.upsert({
            where: {
              exchangeId_nativeSymbol: {
                exchangeId: ex.id,
                nativeSymbol: m.nativeSymbol,
              },
            },
            create: {
              exchangeId: ex.id,
              nativeSymbol: m.nativeSymbol,
              baseAsset: m.baseAsset,
              quoteAsset: "USDT",
              kind: "USDT_PERP",
              active: true,
            },
            update: {
              baseAsset: m.baseAsset,
              quoteAsset: "USDT",
              active: true,
            },
          });
        }

        for (const l of snapshot.latest) {
          const market = await client.market.findUnique({
            where: {
              exchangeId_nativeSymbol: {
                exchangeId: ex.id,
                nativeSymbol: l.nativeSymbol,
              },
            },
          });
          if (!market) continue;

          await client.fundingLatest.upsert({
            where: { marketId: market.id },
            create: {
              marketId: market.id,
              rate: decimalRate(l.rate),
              nextFundingTime: l.nextFundingTime ?? null,
              fetchedAt: new Date(),
            },
            update: {
              rate: decimalRate(l.rate),
              nextFundingTime: l.nextFundingTime ?? null,
              fetchedAt: new Date(),
            },
          });
        }

        await client.adapterLog.create({
          data: {
            syncRunId: run.id,
            exchangeId: ex.id,
            status: "ok",
            message: `markets=${snapshot.markets.length}, latest=${snapshot.latest.length}`,
            durationMs: Date.now() - t0,
          },
        });
      } catch (e) {
        partial = true;
        await client.adapterLog.create({
          data: {
            syncRunId: run.id,
            exchangeId: ex.id,
            status: "error",
            message: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - t0,
          },
        });
      }
    }

    const historyPartial = await syncHistorySlice(client, run.id);
    if (historyPartial) partial = true;
  } catch {
    partial = true;
  } finally {
    await client.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: partial ? "partial" : "success",
      },
    });
  }
}

async function syncHistorySlice(
  client: PrismaClient,
  syncRunId: string,
): Promise<boolean> {
  const total = await client.market.count();
  if (total === 0) return false;

  let partial = false;

  const state = await client.appState.upsert({
    where: { id: 1 },
    create: { id: 1, historyCursor: 0 },
    update: {},
  });

  const cursor = state.historyCursor % total;
  const marketsSlice = await client.market.findMany({
    orderBy: { id: "asc" },
    skip: cursor,
    take: Math.min(HISTORY_SLICE, total),
    include: { exchange: true },
  });

  const nextCursor = (cursor + marketsSlice.length) % total;
  await client.appState.update({
    where: { id: 1 },
    data: { historyCursor: nextCursor },
  });

  const now = Date.now();
  const defaultSince = new Date(now - HISTORY_WINDOW_MS);
  const until = new Date(now);

  for (const market of marketsSlice) {
    const slug = market.exchange.slug as ExchangeAdapterSlug;
    const adapter = EXCHANGE_ADAPTERS[slug];
    if (!adapter) continue;

    const t0 = Date.now();
    try {
      const last = await client.fundingHistoryPoint.findFirst({
        where: { marketId: market.id },
        orderBy: { fundingTime: "desc" },
        select: { fundingTime: true },
      });

      const since = last
        ? new Date(last.fundingTime.getTime() + 1)
        : defaultSince;

      if (since.getTime() >= until.getTime()) continue;

      const points = await adapter.fetchFundingHistory(market.nativeSymbol, {
        since,
        until,
      });
      if (points.length === 0) continue;

      const existing = await client.fundingHistoryPoint.findMany({
        where: {
          marketId: market.id,
          fundingTime: { gte: since, lte: until },
        },
        select: { fundingTime: true },
      });
      const existingMs = new Set(
        existing.map((e) => e.fundingTime.getTime()),
      );

      const rows = points
        .filter((p) => !existingMs.has(p.fundingTime.getTime()))
        .map((p) => ({
          marketId: market.id,
          fundingTime: p.fundingTime,
          rate: decimalRate(p.rate),
        }));
      if (rows.length === 0) continue;

      for (let i = 0; i < rows.length; i += HISTORY_INSERT_CHUNK) {
        const chunk = rows.slice(i, i + HISTORY_INSERT_CHUNK);
        await client.fundingHistoryPoint.createMany({ data: chunk });
      }
    } catch (e) {
      partial = true;
      await client.adapterLog.create({
        data: {
          syncRunId,
          exchangeId: market.exchangeId,
          status: "history_error",
          message: `${market.nativeSymbol}: ${
            e instanceof Error ? e.message : String(e)
          }`,
          durationMs: Date.now() - t0,
        },
      });
    }
  }

  return partial;
}
