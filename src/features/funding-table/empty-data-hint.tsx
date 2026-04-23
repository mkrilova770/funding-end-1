"use client";

import type { FundingPeriodUi } from "@/features/funding-table/funding-ui-store";

type Meta = {
  exchangeCount: number;
  marketCount: number;
  live?: boolean;
  needsHistoryDb?: boolean;
};

export function EmptyDataHint({
  period,
  total,
  meta,
  hasSearch,
}: {
  period: FundingPeriodUi;
  total: number;
  meta: Meta | undefined;
  hasSearch: boolean;
}) {
  if (meta?.needsHistoryDb && (period === "week" || period === "month")) {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-50">
        <p className="font-medium">Суммы за «Неделю» и «Месяц» считаются из истории в базе данных.</p>
        <p className="mt-2 text-muted-foreground dark:text-sky-100/80">
          Сейчас БД недоступна или пуста. Откройте вкладку «Сейчас» — там данные идут напрямую с бирж без ожидания
          синка. Для недели/месяца выполните:{" "}
          <code className="rounded bg-background/60 px-1">npm run db:push</code>,{" "}
          <code className="rounded bg-background/60 px-1">npm run db:seed</code>, затем{" "}
          <code className="rounded bg-background/60 px-1">npm run sync:once</code>.
        </p>
      </div>
    );
  }

  if (total > 0) return null;

  if (hasSearch) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
        По текущему поиску совпадений нет. Очистите поле поиска или измените запрос.
      </div>
    );
  }

  if (!meta) return null;

  if (meta.live && total === 0) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Не удалось получить данные ни с одной биржи (сеть, блокировка, таймаут). Повторите попытку позже.
      </div>
    );
  }

  if (!meta.live && meta.exchangeCount === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-50">
        <p className="font-medium">База данных пуста (нет бирж в таблице Exchange).</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Файл <code className="rounded bg-background/60 px-1">.env</code> с{" "}
            <code className="rounded bg-background/60 px-1">DATABASE_URL</code> (см.{" "}
            <code className="rounded bg-background/60 px-1">.env.example</code>).
          </li>
          <li>
            <code className="rounded bg-background/60 px-1">npm run db:push</code>
          </li>
          <li>
            <code className="rounded bg-background/60 px-1">npm run db:seed</code>
          </li>
        </ol>
      </div>
    );
  }

  if (!meta.live && meta.marketCount === 0) {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-50">
        <p className="font-medium">Биржи в БД есть, но рынки ещё не загружены.</p>
        <p className="mt-2 text-muted-foreground dark:text-sky-100/80">
          Запустите{" "}
          <code className="rounded bg-background/60 px-1">npm run sync:once</code> или{" "}
          <code className="rounded bg-background/60 px-1">npm run worker:dev</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
      Данные в БД есть, но таблица пуста для текущего периода/фильтра. Попробуйте вкладку «Сейчас» и сбросьте
      поиск.
    </div>
  );
}
