import { prisma } from "@/lib/db/prisma";
import {
  getTelegramDigestConfig,
  parseMskSlotParts,
} from "@/lib/services/telegram-digest-config";
import { sendTelegramSpreadDigest } from "@/lib/services/telegram-spread-digest";

function getMskParts(d: Date): {
  y: number;
  mo: number;
  day: number;
  h: number;
  m: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPart["type"]) => {
    const v = parts.find((p) => p.type === type)?.value;
    if (v === undefined) throw new Error(`MSK format: missing ${type}`);
    return Number(v);
  };
  return {
    y: get("year"),
    mo: get("month"),
    day: get("day"),
    h: get("hour"),
    m: get("minute"),
  };
}

function matchesConfiguredSlot(
  h: number,
  m: number,
  slots: string[],
): boolean {
  for (const s of slots) {
    const p = parseMskSlotParts(s);
    if (p && p.h === h && p.m === m) return true;
  }
  return false;
}

/**
 * Запускает фоновую проверку раз в 30 с: в выбранные минуты по МСК шлёт дайджест, если включено в БД.
 * Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID. Расписание и порог — из настроек на сайте (Prisma).
 */
export function maybeStartTelegramSpreadDigestScheduler(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.log(
      "[telegram-digest] планировщик не запущен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID",
    );
    return;
  }

  let lastSlotKey = "";

  const tick = async () => {
    let cfg;
    try {
      cfg = await getTelegramDigestConfig(prisma);
    } catch (e) {
      console.error("[telegram-digest] не удалось прочитать настройки из БД", e);
      return;
    }
    if (!cfg.enabled) return;

    const d = new Date();
    const { y, mo, day, h, m } = getMskParts(d);
    if (!matchesConfiguredSlot(h, m, cfg.mskSlots)) return;
    const key = `${y}-${mo}-${day}-${h}-${m}`;
    if (key === lastSlotKey) return;
    lastSlotKey = key;
    try {
      await sendTelegramSpreadDigest();
      console.log(
        `[telegram-digest] отправлено @ МСК ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      );
    } catch (e) {
      console.error("[telegram-digest] ошибка отправки", e);
    }
  };

  void tick();
  setInterval(() => void tick(), 30_000);
  console.log(
    "[telegram-digest] планировщик активен (слоты и порог из БД / настроек на сайте)",
  );
}
