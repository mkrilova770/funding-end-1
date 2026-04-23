import { NextResponse } from "next/server";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import {
  getLiveFundingTableNow,
  getLiveFundingTablePeriod,
} from "@/lib/services/funding-table-live";
import {
  normalizeFundingTableSortDir,
  normalizeFundingTableSortKey,
  type FundingPeriod,
} from "@/lib/services/funding-table";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import type { FundingTableResult } from "@/lib/services/funding-table";

export const runtime = "nodejs";

function parseVisible(raw: string | null): ExchangeAdapterSlug[] {
  if (!raw) return [...ALL_EXCHANGE_SLUGS];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ExchangeAdapterSlug[];
  const allowed = new Set<string>(ALL_EXCHANGE_SLUGS);
  const filtered = parts.filter((p) => allowed.has(p));
  return filtered.length ? filtered : [...ALL_EXCHANGE_SLUGS];
}

function parsePeriod(raw: string | null): FundingPeriod {
  if (raw === "week" || raw === "month" || raw === "now") return raw;
  return "now";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const q = url.searchParams.get("q") ?? undefined;
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "50");
  const visible = parseVisible(url.searchParams.get("visible"));
  const sortBy = normalizeFundingTableSortKey(url.searchParams.get("sort"));
  const sortDir = normalizeFundingTableSortDir(
    url.searchParams.get("dir"),
    sortBy,
  );

  const opts = {
    period,
    q,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 50,
    visibleExchanges: visible,
    sortBy,
    sortDir,
  };

  try {
    if (period === "now") {
      const data = await getLiveFundingTableNow({
        q: opts.q,
        page: opts.page,
        pageSize: opts.pageSize,
        visibleExchanges: opts.visibleExchanges,
        sortBy: opts.sortBy,
        sortDir: opts.sortDir,
      });
      return json(
        data,
        "public, max-age=0, s-maxage=40, stale-while-revalidate=90",
      );
    }

    const data = await getLiveFundingTablePeriod({
      period: period as "week" | "month",
      q: opts.q,
      page: opts.page,
      pageSize: opts.pageSize,
      visibleExchanges: opts.visibleExchanges,
      sortBy: opts.sortBy,
      sortDir: opts.sortDir,
    });
    return json(
      data,
      "public, s-maxage=120, stale-while-revalidate=300",
    );
  } catch (e) {
    console.error(e);
    const empty: FundingTableResult = {
      updatedAt: null,
      total: 0,
      page: opts.page,
      pageSize: opts.pageSize,
      rows: [],
      meta: {
        exchangeCount: 0,
        marketCount: 0,
      },
    };
    return json(empty, "public, s-maxage=5, stale-while-revalidate=30");
  }
}

function json(
  data: FundingTableResult,
  cacheControl = "public, s-maxage=5, stale-while-revalidate=30",
) {
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": cacheControl,
    },
  });
}
