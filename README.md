# Funding Scanner (USDT perpetual)

Публичный dashboard для мониторинга **ставок финансирования (funding)** на **USDT perpetual** рынках на нескольких биржах. Данные агрегируются **на сервере**, UI ходит только в ваш API и БД.

## Стек

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui (Base UI)
- PostgreSQL + Prisma ORM
- TanStack Query (клиентский refetch)
- Zustand + persist (localStorage)
- @dnd-kit (порядок колонок в настройках)
- Worker (`tsx worker/entry.ts`) для периодического синка

## Структура проекта (важное)

- [`src/app/page.tsx`](src/app/page.tsx) — dashboard
- [`src/app/api/funding/table/route.ts`](src/app/api/funding/table/route.ts) — API агрегированной таблицы
- [`src/lib/exchanges/`](src/lib/exchanges/) — адаптеры бирж + реестр [`index.ts`](src/lib/exchanges/index.ts)
- [`src/lib/services/sync.ts`](src/lib/services/sync.ts) — синк: markets/latest + инкрементальная история (round-robin)
- [`src/lib/services/funding-table.ts`](src/lib/services/funding-table.ts) — выборка/агрегация для UI
- [`worker/entry.ts`](worker/entry.ts) — фоновый цикл синка
- [`prisma/schema.prisma`](prisma/schema.prisma) — модели БД
- [`docker-compose.yml`](docker-compose.yml) — Postgres + web + worker

## Подключённые биржи (v1)

Реализованы адаптеры для:

- Binance (USDT-M futures)
- Bybit (linear USDT)
- OKX (SWAP USDT)
- Gate.io (USDT futures)
- Bitget (USDT-FUTURES)
- KuCoin Futures (USDT contracts)
- MEXC (contract v1 bulk funding)
- BingX (swap v2; latest — параллельные запросы по контрактам)
- LBank (USDT perpetual `marketData`; **история funding пока не подключена** — см. TODO в [`src/lib/exchanges/lbank.ts`](src/lib/exchanges/lbank.ts))
- XT (`cg/contracts` + `funding-rate-record`)

## Публичные endpoints (какие данные тянем)

| Биржа | Основной источник “сейчас” | История |
|------|----------------------------|---------|
| Binance | `GET https://fapi.binance.com/fapi/v1/premiumIndex` | `GET /fapi/v1/fundingRate` |
| Bybit | `GET https://api.bybit.com/v5/market/tickers?category=linear` | `GET /v5/market/funding/history` |
| OKX | `GET https://www.okx.com/api/v5/public/instruments?instType=SWAP` + `.../funding-rate` | `GET /api/v5/public/funding-rate-history` |
| Gate | `GET https://api.gateio.ws/api/v4/futures/usdt/tickers` | `GET /api/v4/futures/usdt/funding_rate` |
| Bitget | `GET https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES` | `GET /api/v2/mix/market/history-fund-rate` |
| KuCoin | `GET https://api-futures.kucoin.com/api/v1/contracts/active` + `.../funding-rate/{symbol}/current` | `GET /api/v1/contract/funding-rates` |
| MEXC | `GET https://contract.mexc.com/api/v1/contract/funding_rate` | `GET /api/v1/contract/funding_rate/history` |
| BingX | `GET https://open-api.bingx.com/openApi/swap/v2/quote/contracts` + `.../fundingRate` | `GET .../fundingRate?startTime&endTime` |
| LBank | `GET https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU&productType=PERPETUAL` | TODO |
| XT | `GET https://fapi.xt.com/future/market/v1/public/cg/contracts` | `GET .../q/funding-rate-record` |

## Таблицы Prisma

- `Exchange` — справочник бирж (slug/name)
- `Market` — рынок (`nativeSymbol`, `baseAsset`, `quoteAsset`, `USDT_PERP`)
- `FundingLatest` — последний funding по рынку
- `FundingHistoryPoint` — события funding (timestamp + rate)
- `SyncRun` / `AdapterLog` — журнал синков (в т.ч. partial failure)
- `AppState` — служебный курсор round-robin для истории

## Как считаются значения

### Сейчас

Берётся последний `FundingLatest.rate` по каждой паре **(baseAsset, биржа)**.

### Неделя / Месяц

Считается **сумма** `FundingHistoryPoint.rate` за окно:

- **Неделя**: последние 7 суток
- **Месяц**: последние 30 суток

Это **не среднее**, а именно сумма ставок по событиям funding, как приходит из API биржи (после нормализации в единый формат хранения).

### Макс. спред

Для строки (монеты) и выбранного периода:

\[
\text{maxSpread} = \max(\text{rates}) - \min(\text{rates})
\]

Учитываются только **включённые в запрос биржи** (query `visible=...`) и только ячейки с данными. Если данных **меньше 2**, значение `null` → в UI показывается `-`.

Сортировка по умолчанию: **по убыванию maxSpread**, `null` в конец.

## localStorage (Zustand persist)

Ключ: `funding-dashboard-ui`

Сохраняется:

- `search`
- `period`
- `pageSize`
- `columnOrder`
- `columnVisibility`

## Запуск локально

1) Поднимите PostgreSQL (например Docker):

```bash
docker compose up -d postgres
```

2) Создайте `.env` из примера:

```bash
copy .env.example .env
```

3) Миграции + seed:

```bash
npm run db:migrate
npm run db:seed
```

4) Первый импорт данных с бирж (один раз, удобно для старта):

```bash
npm run sync:once
```

5) Для постоянного обновления — worker (синк каждые ~45с):

```bash
npm run worker:dev
```

6) Next.js:

```bash
npm run dev
```

Откройте `http://localhost:3000`.

## Запуск в Docker (web + worker)

```bash
docker compose up --build
```

## API для фронта

`GET /api/funding/table`

Query:

- `period`: `now` | `week` | `month`
- `page`, `pageSize`
- `q`: поиск по тикеру (case-insensitive)
- `visible`: список slug бирж через запятую (например `binance,bybit`)

## Дальнейшее развитие (заложено в архитектуру)

- Полноценная **модалка истории** по монете/бирже (сейчас колонка “История” — disabled placeholder)
- История **LBank** (нужен стабильный публичный endpoint + обход/совместимость с WAF)
- Уведомления/алерты, больше бирж, annualization/APR, учёт интервалов funding per-market
- Виртуализация таблицы при росте данных

## Важно про нагрузку

Исторический бэкфилл большой: worker намеренно делает **round-robin** (срез рынков за синк), чтобы не устраивать “шторм” запросов к биржам. Полная история за 30 дней нарастает со временем.
