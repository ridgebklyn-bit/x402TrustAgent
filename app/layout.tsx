export const metadata = {
  title: "X402 Trust Agent - Gold Source Indexing",
  description:
    "Verifiable, hierarchical document indexing monetized over real x402 payments. Original documents are never rewritten, only pointed to with byte-offset and hash proofs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
