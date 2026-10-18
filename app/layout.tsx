export const metadata = {
  title: "X402 Trust Agent - Gold Source Indexing",
  description:
    "Verifiable, hierarchical document indexing monetized over real x402 payments. Original documents are never rewritten: every index node points to an exact span of the source text with a SHA-256 digest.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
