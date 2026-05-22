import { EXCHANGE_LABELS } from "@/lib/exchanges/labels";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";
import { prisma } from "@/lib/db/prisma";
import {
  DEFAULT_MAX_SPREAD_THRESHOLD,
  getTelegramDigestConfig,
} from "@/lib/services/telegram-digest-config";
import { getLiveFundingTableAllRows } from "@/lib/services/funding-table-live";

/** Значение по умолчанию, если БД недоступна (скрипт без миграции). */
export const SPREAD_DIGEST_THRESHOLD = DEFAULT_MAX_SPREAD_THRESHOLD;

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSpreadPct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

function slugLabels(slugs: ExchangeAdapterSlug[]): string {
  return slugs.map((s) => EXCHANGE_LABELS[s] ?? s).join(" / ");
}

export function buildSpreadDigestMessage(opts: {
  rows: { baseAsset: string; maxSpread: number | null; maxSpreadSlugs: ExchangeAdapterSlug[] }[];
  updatedAtIso: string;
  titleSuffix: string;
  /** Порог в долях (как maxSpread в таблице); строго больше этого значения. */
  thresholdFraction: number;
}): string {
  const thr = opts.thresholdFraction;
  const filtered = opts.rows.filter(
    (r) =>
      r.maxSpread !== null &&
      Number.isFinite(r.maxSpread) &&
      r.maxSpread > thr,
  );
  const pctLabel = (thr * 100).toFixed(2).replace(".", ",");
  const lines: string[] = [
    `<b>Фандинг: max спред &gt; ${escapeHtml(pctLabel)}%</b> (${escapeHtml(opts.titleSuffix)})`,
    `<i>Обновлено: ${escapeHtml(opts.updatedAtIso)}</i>`,
    "",
  ];
  if (filtered.length === 0) {
    lines.push("Нет токенов выше порога.");
  } else {
    lines.push(`Всего: <b>${filtered.length}</b>`, "");
    for (const r of filtered) {
      const pct = formatSpreadPct(r.maxSpread!);
      const labs = slugLabels(r.maxSpreadSlugs ?? []);
      lines.push(
        `• <b>${escapeHtml(r.baseAsset)}</b> — ${escapeHtml(pct)}${labs ? ` (${escapeHtml(labs)})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function buildMaxFundingDigestMessage(opts: {
  rows: {
    baseAsset: string;
    ratesByExchange: Partial<Record<ExchangeAdapterSlug, number | null>>;
  }[];
  updatedAtIso: string;
  titleSuffix: string;
  /** Порог в долях; строго выше порога. */
  thresholdFraction: number;
}): string {
  const thr = opts.thresholdFraction;
  const picked = opts.rows
    .map((r) => {
      let maxVal: number | null = null;
      let maxSlug: ExchangeAdapterSlug | null = null;
      for (const [slugRaw, v] of Object.entries(r.ratesByExchange)) {
        const slug = slugRaw as ExchangeAdapterSlug;
        if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
        if (maxVal === null || v > maxVal) {
          maxVal = v;
          maxSlug = slug;
        }
      }
      return { baseAsset: r.baseAsset, v: maxVal, slug: maxSlug };
    })
    .filter((x) => x.v !== null && (x.v as number) > thr)
    .sort((a, b) => (b.v as number) - (a.v as number));

  const pctLabel = (thr * 100).toFixed(2).replace(".", ",");
  const lines: string[] = [
    `<b>Фандинг: max фандинг &gt; ${escapeHtml(pctLabel)}%</b> (${escapeHtml(opts.titleSuffix)})`,
    `<i>Обновлено: ${escapeHtml(opts.updatedAtIso)}</i>`,
    "",
  ];
  if (picked.length === 0) {
    lines.push("Нет токенов выше порога.");
  } else {
    lines.push(`Всего: <b>${picked.length}</b>`, "");
    for (const r of picked) {
      const pct = formatSpreadPct(r.v as number);
      const lbl = r.slug ? EXCHANGE_LABELS[r.slug] ?? r.slug : "";
      lines.push(
        `• <b>${escapeHtml(r.baseAsset)}</b> — ${escapeHtml(pct)}${lbl ? ` (${escapeHtml(lbl)})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

async function telegramSendMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID должны быть заданы");
  }
  const maxChunk = 3900;
  for (let i = 0; i < text.length; i += maxChunk) {
    const chunk = text.slice(i, i + maxChunk);
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!res.ok || body.ok === false) {
      throw new Error(
        `Telegram API: ${res.status} ${body.description ?? JSON.stringify(body)}`,
      );
    }
  }
}

/**
 * Собирает live-таблицу по всем биржам и шлёт в Telegram токены с max спредом по фандингу выше порога из БД.
 */
export async function sendTelegramSpreadDigest(): Promise<void> {
  let thresholdFraction = SPREAD_DIGEST_THRESHOLD;
  let digestExchanges: ExchangeAdapterSlug[] | undefined = undefined;
  try {
    const cfg = await getTelegramDigestConfig(prisma);
    thresholdFraction = cfg.maxSpreadThreshold;
    digestExchanges = cfg.exchanges;
  } catch {
    /* БД не готова — дефолтный порог */
  }
  const rows = await getLiveFundingTableAllRows(digestExchanges);
  const updatedAtIso = new Date().toISOString();
  const titleSuffix = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
  const spreadMsg = buildSpreadDigestMessage({
    rows,
    updatedAtIso,
    titleSuffix,
    thresholdFraction,
  });
  const maxFundingMsg = buildMaxFundingDigestMessage({
    rows,
    updatedAtIso,
    titleSuffix,
    thresholdFraction,
  });
  await telegramSendMessage(spreadMsg);
  await telegramSendMessage(maxFundingMsg);
}
