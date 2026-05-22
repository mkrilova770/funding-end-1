import type {
  ExchangeFundingAdapter,
  ExchangeAdapterSlug,
  FundingHistoryPoint,
  LatestFunding,
  NormalizedMarket,
} from "@/lib/exchanges/types";

/**
 * Публичный REST для котировок Ourbit в открытом доступе не зафиксирован —
 * адаптер не ломает синк остальных бирж и возвращает пустой снимок.
 * История funding и kline через публичный API недоступны.
 */
export const ourbitAdapter: ExchangeFundingAdapter = {
  slug: "ourbit" as ExchangeAdapterSlug,
  supportsHistory: false,

  async fetchMarketsWithLatest(): Promise<{
    markets: NormalizedMarket[];
    latest: LatestFunding[];
  }> {
    return { markets: [], latest: [] };
  },

  async fetchFundingHistory(): Promise<FundingHistoryPoint[]> {
    return [];
  },
};
