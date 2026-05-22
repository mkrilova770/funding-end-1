# Funding Scanner — контекст для агентов

Это **не спотовая биржа**, а **внутренний/свой dashboard**: мониторинг **ставок финансирования (funding rate)** на **USDT perpetual** по множеству бирж, сравнение спредов между площадками, сохранённые тикеры, периоды «сейчас / неделя / месяц». Данные для режима «Сейчас» часто идут **напрямую с публичных API бирж** (адаптеры в `src/lib/exchanges/`); БД + worker — для синка и истории где нужно.

Полное описание стека, структуры и endpoints: **`README.md`**.

Ключевые точки входа:

- UI: `src/app/page.tsx`, `src/features/funding-table/`
- API таблицы: `src/app/api/funding/table/route.ts`
- Live-агрегация: `src/lib/services/funding-table-live.ts`
- Адаптеры бирж: `src/lib/exchanges/` + реестр `src/lib/exchanges/index.ts`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
