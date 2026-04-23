import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { cn } from "@/lib/utils";

/** Домены для Google favicon API (где прямой favicon не подходит). */
const EXCHANGE_ICON_DOMAINS: Record<ExchangeAdapterSlug, string> = {
  gate: "gate.io",
  bitget: "bitget.com",
  bingx: "bingx.com",
  mexc: "mexc.com",
  bybit: "bybit.com",
  okx: "www.okx.com",
  kucoin: "kucoin.com",
  lbank: "lbank.com",
  xt: "xt.com",
  binance: "binance.com",
};

/**
 * Прямые URL иконок (Google s2 для OKX часто отдаёт пустой/битый PNG ~300 байт).
 */
const EXCHANGE_ICON_DIRECT: Partial<Record<ExchangeAdapterSlug, string>> = {
  okx: "https://www.okx.com/favicon.ico",
};

export function isExchangeAdapterSlug(id: string): id is ExchangeAdapterSlug {
  return (ALL_EXCHANGE_SLUGS as readonly string[]).includes(id);
}

export function exchangeFaviconUrl(slug: ExchangeAdapterSlug): string {
  const direct = EXCHANGE_ICON_DIRECT[slug];
  if (direct) return direct;
  const host = EXCHANGE_ICON_DOMAINS[slug];
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

type ExchangeIconProps = {
  slug: ExchangeAdapterSlug;
  className?: string;
  /** Подпись для скринридеров; по умолчанию без объявления (декоративная иконка рядом с текстом) */
  title?: string;
};

export function ExchangeIcon({ slug, className, title }: ExchangeIconProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- внешние favicon, без оптимизации Next Image
    <img
      src={exchangeFaviconUrl(slug)}
      alt=""
      title={title}
      width={24}
      height={24}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn("object-contain", className)}
    />
  );
}
