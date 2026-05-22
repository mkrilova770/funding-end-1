import { ascendexAdapter } from "@/lib/exchanges/ascendex";
import { asterdexAdapter } from "@/lib/exchanges/asterdex";
import { binanceAdapter } from "@/lib/exchanges/binance";
import { bingxAdapter } from "@/lib/exchanges/bingx";
import { bitgetAdapter } from "@/lib/exchanges/bitget";
import { bitmartAdapter } from "@/lib/exchanges/bitmart";
import { bitrueAdapter } from "@/lib/exchanges/bitrue";
import { bitunixAdapter } from "@/lib/exchanges/bitunix";
import { blofinAdapter } from "@/lib/exchanges/blofin";
import { bybitAdapter } from "@/lib/exchanges/bybit";
import { coinexAdapter } from "@/lib/exchanges/coinex";
import { coinwAdapter } from "@/lib/exchanges/coinw";
import { gateAdapter } from "@/lib/exchanges/gate";
import { hyperliquidAdapter } from "@/lib/exchanges/hyperliquid";
import { htxAdapter } from "@/lib/exchanges/htx";
import { krakenAdapter } from "@/lib/exchanges/kraken";
import { kucoinAdapter } from "@/lib/exchanges/kucoin";
import { lbankAdapter } from "@/lib/exchanges/lbank";
import { mexcAdapter } from "@/lib/exchanges/mexc";
import { okxAdapter } from "@/lib/exchanges/okx";
import { ourbitAdapter } from "@/lib/exchanges/ourbit";
import { phemexAdapter } from "@/lib/exchanges/phemex";
import { tapbitAdapter } from "@/lib/exchanges/tapbit";
import { toobitAdapter } from "@/lib/exchanges/toobit";
import { whitebitAdapter } from "@/lib/exchanges/whitebit";
import { wooxAdapter } from "@/lib/exchanges/woox";
import { xtAdapter } from "@/lib/exchanges/xt";
import { zoomexAdapter } from "@/lib/exchanges/zoomex";
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
  htx: htxAdapter,
  kraken: krakenAdapter,
  bitmart: bitmartAdapter,
  toobit: toobitAdapter,
  coinw: coinwAdapter,
  ourbit: ourbitAdapter,
  zoomex: zoomexAdapter,
  coinex: coinexAdapter,
  phemex: phemexAdapter,
  bitunix: bitunixAdapter,
  whitebit: whitebitAdapter,
  tapbit: tapbitAdapter,
  ascendex: ascendexAdapter,
  bitrue: bitrueAdapter,
  blofin: blofinAdapter,
  woox: wooxAdapter,
  asterdex: asterdexAdapter,
  hyperliquid: hyperliquidAdapter,
};

export const ALL_EXCHANGE_SLUGS: ExchangeAdapterSlug[] = [
  "gate",
  "bitget",
  "bingx",
  "mexc",
  "bybit",
  "okx",
  "hyperliquid",
  "kucoin",
  "lbank",
  "xt",
  "binance",
  "asterdex",
  "htx",
  "kraken",
  "bitmart",
  "toobit",
  "coinw",
  "ourbit",
  "zoomex",
  "coinex",
  "phemex",
  "bitunix",
  "whitebit",
  "tapbit",
  "ascendex",
  "bitrue",
  "blofin",
  "woox",
];
