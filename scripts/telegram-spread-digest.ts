/**
 * Одноразовая отправка дайджеста в Telegram (для внешнего cron вместо планировщика в worker).
 *
 *   npm run notify:telegram
 */
import "dotenv/config";
import { sendTelegramSpreadDigest } from "../src/lib/services/telegram-spread-digest";

sendTelegramSpreadDigest()
  .then(() => {
    console.log("telegram-spread-digest: ok");
    process.exit(0);
  })
  .catch((e) => {
    console.error("telegram-spread-digest:", e);
    process.exit(1);
  });
