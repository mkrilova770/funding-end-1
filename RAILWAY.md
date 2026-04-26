# Деплой на Railway

## Два сервиса из одного репозитория

1. **Web** (сайт Next.js)  
   - **Build:** `npm run build`  
   - **Start:** `npm run start`  
   - **Root directory:** корень репозитория (или тот же, что и у воркера).

2. **Worker** (синк фандинга + Telegram по расписанию)  
   - **Build:** можно тот же `npm run build` или `npm ci` (нужен `prisma generate` — он уже в `postinstall` и в `build`).  
   - **Start:** `npm run worker`  
   - Переменные окружения должны совпадать с вебом по **БД** и **Telegram**, иначе воркер не увидет токен или подключится к другой базе.

После первого деплоя выполните миграцию схемы (таблица настроек Telegram и др.):

```bash
railway run --service <имя-web-или-worker> npx prisma db push
```

Или одноразово в shell сервиса на Railway.

---

## Variables (Railway → Project → выбранный сервис → **Variables**)

Задайте те же имена, что в `.env.example`. Для **Web** и **Worker** скопируйте значения (или используйте **Shared Variables** / Reference между сервисами).

| Name | Обязательно | Описание |
|------|-------------|----------|
| `DATABASE_URL` | да | Строка подключения Prisma (на Railway часто PostgreSQL из плагина; для SQLite — путь на volume, если настроите). |
| `TELEGRAM_BOT_TOKEN` | да для уведомлений | Токен бота от @BotFather. |
| `TELEGRAM_CHAT_ID` | да для уведомлений | Ваш chat id (например через @userinfobot). |
| `TELEGRAM_SPREAD_DIGEST_ENABLED` | нет | Только при **первом** создании строки в БД: `1`/`true` — включит рассылку в БД до первого сохранения с сайта. Дальше управление — галочка в UI. |
| `TELEGRAM_DIGEST_UI_SECRET` | нет | Если задан — сохранение настроек Telegram и кнопка «Отправить тест» требуют `Authorization: Bearer …` с этим значением. |
| `SYNC_INTERVAL_MS` | нет | По умолчанию `45000`. |
| `SYNC_HISTORY_CONCURRENCY` | нет | По умолчанию `6`. |
| `NODE_ENV` | нет | Для продакшена обычно `production`. |

Railway подставляет переменные в `process.env`; файл `.env` на сервере не нужен. Локально можно снять галочку «Включить рассылку» и сохранить — воркер на вашем ПК перестанет слать; **на Railway** рассылка идёт из **своей** БД и настроек UI, привязанных к продакшен-URL (если `DATABASE_URL` другой).

---

## Проверка Telegram с Railway

1. В Variables воркера заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.  
2. На **продакшен-сайте** открыть **Telegram** → включить рассылку, слоты, порог → **Сохранить**.  
3. **Отправить тест сейчас** — сообщение должно прийти от бота (запрос идёт с сервера Next на Railway, не с ПК).
