import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXCHANGES = [
  { slug: "gate", name: "Gate", sortOrder: 10 },
  { slug: "bitget", name: "Bitget", sortOrder: 20 },
  { slug: "bingx", name: "BingX", sortOrder: 30 },
  { slug: "mexc", name: "MEXC", sortOrder: 40 },
  { slug: "bybit", name: "Bybit", sortOrder: 50 },
  { slug: "okx", name: "OKX", sortOrder: 60 },
  { slug: "kucoin", name: "KuCoin", sortOrder: 70 },
  { slug: "lbank", name: "LBank", sortOrder: 80 },
  { slug: "xt", name: "XT", sortOrder: 90 },
  { slug: "binance", name: "Binance", sortOrder: 100 },
] as const;

async function main() {
  await prisma.appState.upsert({
    where: { id: 1 },
    create: { id: 1, historyCursor: 0 },
    update: {},
  });

  for (const ex of EXCHANGES) {
    await prisma.exchange.upsert({
      where: { slug: ex.slug },
      create: {
        slug: ex.slug,
        name: ex.name,
        sortOrder: ex.sortOrder,
        enabled: true,
      },
      update: {
        name: ex.name,
        sortOrder: ex.sortOrder,
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
