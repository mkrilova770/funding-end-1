import { binanceAdapter } from "@/lib/exchanges/binance";
import { bingxAdapter } from "@/lib/exchanges/bingx";
import { bitgetAdapter } from "@/lib/exchanges/bitget";
import { bybitAdapter } from "@/lib/exchanges/bybit";
import { gateAdapter } from "@/lib/exchanges/gate";
import { kucoinAdapter } from "@/lib/exchanges/kucoin";
import { lbankAdapter } from "@/lib/exchanges/lbank";
import { mexcAdapter } from "@/lib/exchanges/mexc";
import { okxAdapter } from "@/lib/exchanges/okx";
import { xtAdapter } from "@/lib/exchanges/xt";
import type {
  ExchangeAdapterSlug,
  ExchangeFundingAdapter,
} from "@/lib/exchanges/types";

export const EXCHANGE_ADAPTERS: Record<
  ExchangeAdapterSlug,
  ExchangeFundingAdapter
> = {
  binance: binanceAdapter,
  bybit: bybitAdapter,
  okx: okxAdapter,
  gate: gateAdapter,
  bitget: bitgetAdapter,
  kucoin: kucoinAdapter,
  mexc: mexcAdapter,
  bingx: bingxAdapter,
  lbank: lbankAdapter,
  xt: xtAdapter,
};

export const ALL_EXCHANGE_SLUGS: ExchangeAdapterSlug[] = [
  "gate",
  "bitget",
  "bingx",
  "mexc",
  "bybit",
  "okx",
  "kucoin",
  "lbank",
  "xt",
  "binance",
];
