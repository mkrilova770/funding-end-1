import { prisma } from "../src/lib/db/prisma";
import { runFundingSync } from "../src/lib/services/sync";

const intervalMs = Number(process.env.SYNC_INTERVAL_MS ?? 45_000);

async function tick() {
  try {
    await runFundingSync(prisma);
    console.log(`[worker] sync ok @ ${new Date().toISOString()}`);
  } catch (e) {
    console.error("[worker] sync failed", e);
  }
}

async function main() {
  await tick();
  setInterval(tick, intervalMs);
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
