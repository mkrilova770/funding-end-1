import { NextResponse } from "next/server";
import { sendTelegramSpreadDigest } from "@/lib/services/telegram-spread-digest";

export const runtime = "nodejs";

function settingsSecretOk(req: Request): boolean {
  const need = (process.env.TELEGRAM_DIGEST_UI_SECRET ?? "").trim();
  if (!need) return true;
  const auth = req.headers.get("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() === need;
  }
  const x = req.headers.get("x-telegram-digest-secret")?.trim();
  return x === need;
}

/** POST — сразу отправить тестовый дайджест в Telegram (текущий порог из БД). */
export async function POST(req: Request) {
  if (!settingsSecretOk(req)) {
    return NextResponse.json({ error: "Неверный или отсутствует секрет" }, { status: 401 });
  }
  if (
    !process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    !process.env.TELEGRAM_CHAT_ID?.trim()
  ) {
    return NextResponse.json(
      { error: "Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID на сервере" },
      { status: 503 },
    );
  }
  try {
    await sendTelegramSpreadDigest();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Ошибка отправки";
    console.error("[telegram-digest test]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
