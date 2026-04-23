import { NextResponse } from "next/server";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import {
  clampHistoryDays,
  getFundingHistorySeries,
} from "@/lib/services/funding-history-series";

export const runtime = "nodejs";

const BASE_RE = /^[A-Z0-9]{1,40}$/;

function parseExchange(raw: string | null): ExchangeAdapterSlug | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const hit = ALL_EXCHANGE_SLUGS.find((x) => x === s);
  return hit ?? null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const exchange = parseExchange(url.searchParams.get("exchange"));
  const baseRaw = (url.searchParams.get("base") ?? "").trim().toUpperCase();
  const days = clampHistoryDays(
    Number(url.searchParams.get("days") ?? "30"),
  );

  if (!exchange) {
    return NextResponse.json(
      { error: "Укажите параметр exchange" },
      { status: 400 },
    );
  }
  if (!baseRaw || !BASE_RE.test(baseRaw)) {
    return NextResponse.json(
      { error: "Некорректный параметр base" },
      { status: 400 },
    );
  }

  try {
    const data = await getFundingHistorySeries({
      exchange,
      baseAsset: baseRaw,
      days,
    });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, max-age=60, s-maxage=120",
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === "MARKET_NOT_FOUND") {
      return NextResponse.json(
        { error: "Рынок не найден на этой бирже" },
        { status: 404 },
      );
    }
    console.error(e);
    return NextResponse.json(
      { error: "Не удалось загрузить историю" },
      { status: 500 },
    );
  }
}
