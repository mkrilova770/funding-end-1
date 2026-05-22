import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppProviders } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Отслеживание фандинга криптовалют",
  description:
    "Публичный dashboard: ставки финансирования USDT perpetual на нескольких биржах.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full w-full min-w-0 flex-col bg-background text-foreground">
        <AppProviders>
          <div className="flex w-full min-w-0 flex-1 flex-col">{children}</div>
        </AppProviders>
      </body>
    </html>
  );
}
