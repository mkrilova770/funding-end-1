/** Рынок USDT perpetual в нативном представлении биржи + нормализованный base. */
export type NormalizedMarket = {
  nativeSymbol: string;
  baseAsset: string;
  quoteAsset: "USDT";
};

export type LatestFunding = {
  nativeSymbol: string;
  /** Десятичная строка, например "0.0001" */
  rate: string;
  nextFundingTime?: Date | null;
  /** Mark-price (строка) — если биржа возвращает его вместе с фандингом */
  markPrice?: string;
  /** Лучшая цена покупки (bid) */
  bestBid?: string;
  /** Лучшая цена продажи (ask) */
  bestAsk?: string;
};

export type KlinePoint = {
  time: number;
  close: number;
};

export type FundingHistoryPoint = {
  nativeSymbol: string;
  fundingTime: Date;
  /** Десятичная строка */
  rate: string;
};

export type ExchangeAdapterSlug =
  | "binance"
  | "bybit"
  | "okx"
  | "gate"
  | "bitget"
  | "kucoin"
  | "mexc"
  | "bingx"
  | "lbank"
  | "xt";

export interface ExchangeFundingAdapter {
  readonly slug: ExchangeAdapterSlug;
  /** false if the exchange WAF/API doesn't expose historical funding rates */
  readonly supportsHistory?: boolean;
  /** Список рынков + текущий funding (одним или несколькими HTTP-запросами). */
  fetchMarketsWithLatest(): Promise<{
    markets: NormalizedMarket[];
    latest: LatestFunding[];
  }>;
  /**
   * История funding-событий в окне [since, until] включительно по времени биржи.
   * Адаптер обязан вернуть rate за конкретное событие (как отдаёт API), без усреднения.
   */
  fetchFundingHistory(
    nativeSymbol: string,
    range: { since: Date; until: Date },
  ): Promise<FundingHistoryPoint[]>;
  /** OHLC-свечи для расчёта ценового спреда между биржами. intervalMin по умолчанию 240 (4ч). */
  fetchKlines?(
    nativeSymbol: string,
    range: { since: Date; until: Date },
    intervalMin?: number,
  ): Promise<KlinePoint[]>;
}
