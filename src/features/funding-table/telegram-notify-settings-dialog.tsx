"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  normalizeMskSlot,
  PRESET_MSK_SLOTS,
} from "@/lib/services/telegram-digest-config";
import { cn } from "@/lib/utils";

type SettingsResponse = {
  maxSpreadThresholdPct: number;
  mskSlots: string[];
  enabled: boolean;
  updatedAt: string | null;
  requiresSecret: boolean;
  hasTelegramEnv: boolean;
};

export function TelegramNotifySettingsDialog() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [thresholdPct, setThresholdPct] = useState("0.25");
  const [slots, setSlots] = useState<Set<string>>(
    () => new Set(PRESET_MSK_SLOTS),
  );
  const [secret, setSecret] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [customTimeError, setCustomTimeError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "ok" | "err">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const qc = useQueryClient();

  const presetSet = useMemo(() => new Set<string>(PRESET_MSK_SLOTS), []);
  const extraSlots = useMemo(
    () =>
      [...slots]
        .filter((s) => !presetSet.has(s))
        .sort((a, b) => a.localeCompare(b)),
    [slots, presetSet],
  );

  const q = useQuery({
    queryKey: ["telegram-digest-settings"],
    queryFn: async (): Promise<SettingsResponse> => {
      const res = await fetch("/api/settings/telegram-digest");
      const j = (await res.json().catch(() => ({}))) as SettingsResponse & {
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        const parts = [j.error, j.hint].filter(Boolean);
        throw new Error(
          parts.length ? parts.join(" ") : "Не удалось загрузить настройки",
        );
      }
      return j as SettingsResponse;
    },
    enabled: open,
  });

  useEffect(() => {
    if (!q.data) return;
    setEnabled(q.data.enabled);
    setThresholdPct(String(q.data.maxSpreadThresholdPct));
    setSlots(new Set(q.data.mskSlots));
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      const pct = Number(thresholdPct.replace(",", "."));
      if (!Number.isFinite(pct) || pct <= 0) {
        throw new Error("Укажите порог в процентах (например 0.25)");
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (secret.trim()) {
        headers.Authorization = `Bearer ${secret.trim()}`;
      }
      const res = await fetch("/api/settings/telegram-digest", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          maxSpreadThresholdPct: pct,
          mskSlots: [...slots],
          enabled,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `Ошибка ${res.status}`);
      return j;
    },
    onSuccess: () => {
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: ["telegram-digest-settings"] });
    },
    onError: (e: Error) => {
      setSaveError(e.message);
    },
  });

  const toggleSlot = useCallback((s: string) => {
    setSlots((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  const addCustomSlot = useCallback(() => {
    setCustomTimeError(null);
    const n = normalizeMskSlot(customTime.trim());
    if (!n) {
      setCustomTimeError("Формат ЧЧ:ММ (например 12:30 или 09:05)");
      return;
    }
    setSlots((prev) => {
      const next = new Set(prev);
      next.add(n);
      return next;
    });
    setCustomTime("");
  }, [customTime]);

  const removeSlot = useCallback((s: string) => {
    setSlots((prev) => {
      const next = new Set(prev);
      next.delete(s);
      return next;
    });
  }, []);

  const sendTest = useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {};
      if (secret.trim()) {
        headers.Authorization = `Bearer ${secret.trim()}`;
      }
      const res = await fetch("/api/settings/telegram-digest/test", {
        method: "POST",
        headers,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok) throw new Error(j.error ?? `Ошибка ${res.status}`);
      return j;
    },
    onMutate: () => {
      setTestStatus("idle");
      setTestMessage(null);
    },
    onSuccess: () => {
      setTestStatus("ok");
      setTestMessage("Сообщение отправлено в Telegram.");
    },
    onError: (e: Error) => {
      setTestStatus("err");
      setTestMessage(e.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Bell className="size-4" aria-hidden />
        Telegram
      </Button>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Уведомления в Telegram</DialogTitle>
          <DialogDescription>
            Порог по столбцу «Max спред» (разница ставок фандинга между биржами). Время —
            Europe/Moscow: пресеты и своё в формате ЧЧ:ММ. Токен бота и chat id — в переменных
            окружения на сервере (воркер). «Отправить тест сейчас» — проверка без ожидания
            расписания.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {q.isLoading ? (
            <p className="text-muted-foreground">Загрузка…</p>
          ) : q.isError ? (
            <p className="text-sm text-destructive whitespace-pre-wrap">
              {(q.error as Error)?.message ?? "Не удалось загрузить настройки"}
            </p>
          ) : (
            <>
              {!q.data?.hasTelegramEnv ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  На сервере не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID — отправка
                  невозможна. Сохранение расписания всё равно запишется в базу.
                </p>
              ) : null}

              <div className="flex items-center gap-3">
                <input
                  id="tg-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="size-4 rounded border-input"
                />
                <Label htmlFor="tg-enabled" className="cursor-pointer font-medium">
                  Включить рассылку по расписанию (воркер)
                </Label>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="tg-threshold">Мин. max спред для списка (%)</Label>
                <Input
                  id="tg-threshold"
                  type="text"
                  inputMode="decimal"
                  value={thresholdPct}
                  onChange={(e) => setThresholdPct(e.target.value)}
                  placeholder="0.25"
                  className="max-w-[140px]"
                />
                <p className="text-xs text-muted-foreground">
                  В уведомление попадут токены, у которых max спред <strong>строго больше</strong>{" "}
                  этого значения (как на сайте: доля × 100 = %).
                </p>
              </div>

              <div className="grid gap-2">
                <span className="text-sm font-medium">Время по МСК</span>
                <div className="flex flex-wrap gap-2">
                  {PRESET_MSK_SLOTS.map((s) => {
                    const id = `tg-preset-${s}`;
                    const on = slots.has(s);
                    return (
                      <div
                        key={s}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm transition-colors",
                          on
                            ? "border-foreground/30 bg-muted/50"
                            : "border-border/80 opacity-80",
                        )}
                      >
                        <input
                          id={id}
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleSlot(s)}
                          className="size-4 shrink-0 rounded border-input"
                        />
                        <Label
                          htmlFor={id}
                          className="cursor-pointer font-mono tabular-nums"
                        >
                          {s}
                        </Label>
                        {on ? (
                          <button
                            type="button"
                            className="ml-0.5 rounded px-1.5 text-base leading-none text-muted-foreground hover:bg-background hover:text-foreground"
                            aria-label={`Удалить ${s}`}
                            onClick={(e) => {
                              e.preventDefault();
                              removeSlot(s);
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  {extraSlots.map((s) => {
                    const id = `tg-extra-${s.replace(":", "-")}`;
                    return (
                      <div
                        key={`extra-${s}`}
                        className="flex items-center gap-1.5 rounded-md border border-foreground/30 bg-muted/50 px-2 py-1.5 text-sm transition-colors"
                      >
                        <input
                          id={id}
                          type="checkbox"
                          checked={slots.has(s)}
                          onChange={() => removeSlot(s)}
                          className="size-4 shrink-0 rounded border-input"
                        />
                        <Label
                          htmlFor={id}
                          className="cursor-pointer font-mono tabular-nums"
                        >
                          {s}
                        </Label>
                        <button
                          type="button"
                          className="ml-0.5 rounded px-1.5 text-base leading-none text-muted-foreground hover:bg-background hover:text-foreground"
                          aria-label={`Удалить ${s}`}
                          onClick={(e) => {
                            e.preventDefault();
                            removeSlot(s);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="grid min-w-[120px] gap-1.5">
                    <Label htmlFor="tg-custom-time" className="text-xs">
                      Своё время (МСК)
                    </Label>
                    <Input
                      id="tg-custom-time"
                      placeholder="12:30"
                      value={customTime}
                      onChange={(e) => {
                        setCustomTime(e.target.value);
                        setCustomTimeError(null);
                      }}
                      className="font-mono text-sm"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mb-0.5"
                    onClick={addCustomSlot}
                  >
                    Добавить
                  </Button>
                </div>
                {customTimeError ? (
                  <p className="text-xs text-destructive">{customTimeError}</p>
                ) : null}
                {slots.size === 0 ? (
                  <p className="text-xs text-amber-800 dark:text-amber-200/90">
                    Нет времён уведомлений — включите пресеты или добавьте своё. Для сохранения нужен хотя бы
                    один слот.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    sendTest.isPending ||
                    !q.data?.hasTelegramEnv ||
                    (q.data?.requiresSecret && !secret.trim())
                  }
                  onClick={() => sendTest.mutate()}
                >
                  {sendTest.isPending ? "Отправка…" : "Отправить тест сейчас"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Дайджест с текущим порогом из БД (как в расписании).
                </span>
                {testStatus === "ok" ? (
                  <p className="w-full text-xs text-emerald-700 dark:text-emerald-400">
                    {testMessage}
                  </p>
                ) : null}
                {testStatus === "err" ? (
                  <p className="w-full text-xs text-destructive">{testMessage}</p>
                ) : null}
              </div>

              {q.data?.requiresSecret ? (
                <div className="grid gap-2">
                  <Label htmlFor="tg-secret">Секрет (из TELEGRAM_DIGEST_UI_SECRET в .env)</Label>
                  <Input
                    id="tg-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Обязателен для сохранения"
                  />
                </div>
              ) : null}

              {q.data?.updatedAt ? (
                <p className="text-xs text-muted-foreground">
                  Последнее сохранение:{" "}
                  {new Date(q.data.updatedAt).toLocaleString("ru-RU")}
                </p>
              ) : null}

              {saveError ? (
                <p className="text-sm text-destructive">{saveError}</p>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="border-t-0 pt-0 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            disabled={save.isPending || q.isLoading || !q.isSuccess}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Сохранение…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
