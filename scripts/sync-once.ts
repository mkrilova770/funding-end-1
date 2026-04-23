import { prisma } from "../src/lib/db/prisma";
import { runFundingSync } from "../src/lib/services/sync";

async function main() {
  console.log("[sync-once] starting…");
  await runFundingSync(prisma);
  console.log("[sync-once] done.");
}

main()
  .catch((e) => {
    console.error("[sync-once] failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
