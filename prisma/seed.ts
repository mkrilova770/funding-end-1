import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXCHANGES = [
  { slug: "gate", name: "Gate", sortOrder: 10 },
  { slug: "bitget", name: "Bitget", sortOrder: 20 },
  { slug: "bingx", name: "BingX", sortOrder: 30 },
  { slug: "mexc", name: "MEXC", sortOrder: 40 },
  { slug: "bybit", name: "Bybit", sortOrder: 50 },
  { slug: "hyperliquid", name: "Hyperliquid", sortOrder: 55 },
  { slug: "okx", name: "OKX", sortOrder: 60 },
  { slug: "kucoin", name: "KuCoin", sortOrder: 70 },
  { slug: "lbank", name: "LBank", sortOrder: 80 },
  { slug: "xt", name: "XT", sortOrder: 90 },
  { slug: "binance", name: "Binance", sortOrder: 100 },
  { slug: "asterdex", name: "Aster", sortOrder: 105 },
  { slug: "htx", name: "HTX", sortOrder: 110 },
  { slug: "kraken", name: "Kraken", sortOrder: 120 },
  { slug: "bitmart", name: "BitMart", sortOrder: 130 },
  { slug: "toobit", name: "Toobit", sortOrder: 140 },
  { slug: "coinw", name: "CoinW", sortOrder: 150 },
  { slug: "ourbit", name: "Ourbit", sortOrder: 160 },
  { slug: "zoomex", name: "Zoomex", sortOrder: 170 },
  { slug: "coinex", name: "CoinEx", sortOrder: 180 },
  { slug: "phemex", name: "Phemex", sortOrder: 190 },
  { slug: "bitunix", name: "Bitunix", sortOrder: 200 },
  { slug: "whitebit", name: "WhiteBIT", sortOrder: 210 },
  { slug: "tapbit", name: "Tapbit", sortOrder: 220 },
  { slug: "ascendex", name: "AscendEX", sortOrder: 230 },
  { slug: "bitrue", name: "Bitrue", sortOrder: 240 },
  { slug: "blofin", name: "BloFin", sortOrder: 250 },
  { slug: "woox", name: "WOO X", sortOrder: 260 },
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
