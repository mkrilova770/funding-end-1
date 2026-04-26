import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  getTelegramDigestConfig,
  upsertTelegramDigestConfig,
} from "@/lib/services/telegram-digest-config";

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

/** GET — текущие настройки (для формы на сайте). */
export async function GET() {
  try {
    const cfg = await getTelegramDigestConfig(prisma);
    const requiresSecret = Boolean(
      (process.env.TELEGRAM_DIGEST_UI_SECRET ?? "").trim(),
    );
    return NextResponse.json({
      maxSpreadThresholdPct: cfg.maxSpreadThreshold * 100,
      mskSlots: cfg.mskSlots,
      enabled: cfg.enabled,
      updatedAt: cfg.updatedAt,
      requiresSecret,
      hasTelegramEnv: Boolean(
        process.env.TELEGRAM_BOT_TOKEN?.trim() &&
          process.env.TELEGRAM_CHAT_ID?.trim(),
      ),
    });
  } catch (e) {
    console.error("[telegram-digest settings GET]", e);
    const raw = e instanceof Error ? e.message : String(e);
    const needsSchema =
      /does not exist|no such table|relation|TelegramDigestConfig|P20[0-9]{2}/i.test(
        raw,
      );
    return NextResponse.json(
      {
        error: needsSchema
          ? "В базе ещё нет таблицы настроек Telegram (схема Prisma не применена к этой БД)."
          : "Не удалось прочитать настройки.",
        hint: needsSchema
          ? "На Railway один раз выполните: npx prisma db push (в shell сервиса, с тем же DATABASE_URL, что у веба)."
          : undefined,
      },
      { status: 500 },
    );
  }
}

type PutBody = {
  maxSpreadThresholdPct?: number;
  mskSlots?: string[];
  enabled?: boolean;
};

/** PUT — сохранить настройки (опционально секрет в заголовке). */
export async function PUT(req: Request) {
  if (!settingsSecretOk(req)) {
    return NextResponse.json({ error: "Неверный или отсутствует секрет" }, { status: 401 });
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const pct = Number(body.maxSpreadThresholdPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 20) {
    return NextResponse.json(
      { error: "maxSpreadThresholdPct: число от 0 до 20 (%)" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.mskSlots)) {
    return NextResponse.json({ error: "mskSlots: массив строк HH:MM" }, { status: 400 });
  }
  try {
    const cfg = await upsertTelegramDigestConfig(prisma, {
      maxSpreadThreshold: pct / 100,
      mskSlots: body.mskSlots,
      enabled: Boolean(body.enabled),
    });
    return NextResponse.json({
      maxSpreadThresholdPct: cfg.maxSpreadThreshold * 100,
      mskSlots: cfg.mskSlots,
      enabled: cfg.enabled,
      updatedAt: cfg.updatedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Ошибка сохранения";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
