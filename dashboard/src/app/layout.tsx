import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PoolSync | Multi-Pool Atomic Constant-Product AMM Rebalance",
  description: "Next-generation constant-product AMM with atomic multi-pool rebalancing, 100% MEV value retention, and mathematically verified invariants.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased selection:bg-blue-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}
