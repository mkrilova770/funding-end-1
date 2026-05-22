import type { PrismaClient } from "@prisma/client";
import { ALL_EXCHANGE_SLUGS } from "@/lib/exchanges";
import type { ExchangeAdapterSlug } from "@/lib/exchanges/types";

/** Доступные слоты по МСК (выбор на сайте). */
export const PRESET_MSK_SLOTS = [
  "22:30",
  "02:30",
  "06:30",
  "10:30",
  "14:30",
  "18:30",
] as const;

export type PresetMskSlot = (typeof PRESET_MSK_SLOTS)[number];

export const DEFAULT_MAX_SPREAD_THRESHOLD = 0.0025;
export type TelegramDigestMetric = "maxSpread" | "maxFunding";

export type TelegramDigestConfigDto = {
  maxSpreadThreshold: number;
  mskSlots: string[];
  exchanges: ExchangeAdapterSlug[];
  metric: TelegramDigestMetric;
  enabled: boolean;
  updatedAt: string | null;
};

function defaultSlotsJson(): string {
  return JSON.stringify([...PRESET_MSK_SLOTS]);
}

/** Нормализованное время МСК «HH:MM» или null. */
export function normalizeMskSlot(slot: string): string | null {
  const p = parseMskSlotParts(slot);
  if (!p) return null;
  return `${String(p.h).padStart(2, "0")}:${String(p.m).padStart(2, "0")}`;
}

function sortSlotsAsc(slots: string[]): string[] {
  const withKey = slots.map((s) => {
    const p = parseMskSlotParts(s);
    return { s, k: p ? p.h * 60 + p.m : 9999 };
  });
  withKey.sort((a, b) => a.k - b.k);
  return withKey.map((x) => x.s);
}

function parseSlotsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [...PRESET_MSK_SLOTS];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...PRESET_MSK_SLOTS];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of arr) {
      if (typeof x !== "string") continue;
      const n = normalizeMskSlot(x);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out.length > 0 ? sortSlotsAsc(out) : [...PRESET_MSK_SLOTS];
  } catch {
    return [...PRESET_MSK_SLOTS];
  }
}

function parseExchangesJson(
  raw: string | null | undefined,
): ExchangeAdapterSlug[] {
  const allowed = new Set<string>(ALL_EXCHANGE_SLUGS);
  if (!raw?.trim()) return [...ALL_EXCHANGE_SLUGS];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...ALL_EXCHANGE_SLUGS];
    const out: ExchangeAdapterSlug[] = [];
    const seen = new Set<string>();
    for (const x of arr) {
      if (typeof x !== "string") continue;
      const slug = x.trim() as ExchangeAdapterSlug;
      if (!allowed.has(slug) || seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
    return out.length > 0 ? out : [...ALL_EXCHANGE_SLUGS];
  } catch {
    return [...ALL_EXCHANGE_SLUGS];
  }
}

function normalizeThreshold(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return DEFAULT_MAX_SPREAD_THRESHOLD;
  return Math.min(0.2, Math.max(0.00005, fraction));
}

function normalizeMetric(raw: unknown): TelegramDigestMetric {
  return raw === "maxFunding" ? "maxFunding" : "maxSpread";
}

export async function getTelegramDigestConfig(
  client: PrismaClient,
): Promise<TelegramDigestConfigDto> {
  let row = await client.telegramDigestConfig.findUnique({ where: { id: 1 } });
  if (!row) {
    const envOn =
      process.env.TELEGRAM_SPREAD_DIGEST_ENABLED === "1" ||
      process.env.TELEGRAM_SPREAD_DIGEST_ENABLED === "true";
    row = await client.telegramDigestConfig.create({
      data: {
        id: 1,
        maxSpreadThreshold: DEFAULT_MAX_SPREAD_THRESHOLD,
        mskSlotsJson: defaultSlotsJson(),
        enabled: envOn,
      },
    });
  }
  return {
    maxSpreadThreshold: row.maxSpreadThreshold,
    mskSlots: parseSlotsJson(row.mskSlotsJson),
    exchanges: parseExchangesJson(row.exchangesJson),
    metric: normalizeMetric((row as { metric?: unknown }).metric),
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type TelegramDigestConfigUpdate = {
  maxSpreadThreshold: number;
  mskSlots: string[];
  exchanges: ExchangeAdapterSlug[];
  metric: TelegramDigestMetric;
  enabled: boolean;
};

const MAX_MSK_SLOTS = 32;

export async function upsertTelegramDigestConfig(
  client: PrismaClient,
  patch: TelegramDigestConfigUpdate,
): Promise<TelegramDigestConfigDto> {
  const seen = new Set<string>();
  const slots: string[] = [];
  for (const raw of patch.mskSlots) {
    const n = normalizeMskSlot(String(raw));
    if (!n || seen.has(n)) continue;
    seen.add(n);
    slots.push(n);
    if (slots.length >= MAX_MSK_SLOTS) break;
  }
  if (slots.length === 0) {
    throw new Error("Добавьте хотя бы одно время по МСК (формат ЧЧ:ММ)");
  }
  const sortedSlots = sortSlotsAsc(slots);
  const threshold = normalizeThreshold(patch.maxSpreadThreshold);
  const allowed = new Set<string>(ALL_EXCHANGE_SLUGS);
  const exchangeSeen = new Set<string>();
  const exchanges: ExchangeAdapterSlug[] = [];
  for (const raw of patch.exchanges) {
    const slug = String(raw).trim() as ExchangeAdapterSlug;
    if (!allowed.has(slug) || exchangeSeen.has(slug)) continue;
    exchangeSeen.add(slug);
    exchanges.push(slug);
  }
  if (exchanges.length === 0) {
    throw new Error("Выберите хотя бы одну биржу для уведомлений");
  }
  await client.telegramDigestConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      maxSpreadThreshold: threshold,
      mskSlotsJson: JSON.stringify(sortedSlots),
      exchangesJson: JSON.stringify(exchanges),
      metric: normalizeMetric(patch.metric),
      enabled: Boolean(patch.enabled),
    },
    update: {
      maxSpreadThreshold: threshold,
      mskSlotsJson: JSON.stringify(sortedSlots),
      exchangesJson: JSON.stringify(exchanges),
      metric: normalizeMetric(patch.metric),
      enabled: Boolean(patch.enabled),
    },
  });
  return getTelegramDigestConfig(client);
}

export function parseMskSlotParts(slot: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}
