import { redirect } from "next/navigation";

// The existing demo/marketing UI lives at public/index.html (unchanged from
// the original standalone app). NOTE: its "Demo bypass (free)" toggle no
// longer works now that every endpoint requires a real x402 payment - that
// UI is a carry-over and needs a real wallet-pay flow to be interactive
// again. Treat it as a marketing/capability page for now; real buyers are
// agents calling the API directly.
export default function Home() {
  redirect("/index.html");
}
