import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  createOfferReceiptExtension,
  createEIP712OfferReceiptIssuer,
  declareOfferReceiptExtension,
} from "@x402/extensions/offer-receipt";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { privateKeyToAccount } from "viem/accounts";

// --- Mainnet switch -----------------------------------------------------------
// Same pattern as AgentX402Pay: set X402_NETWORK=mainnet in Vercel's env vars
// for production. Leave unset for local `next dev` to use the free testnet
// facilitator without needing real funds or CDP credentials on your laptop.
export const IS_MAINNET = process.env.X402_NETWORK === "mainnet";

// Public base URL for this deployment, used to build absolute resource/icon
// URLs below. Override with NEXT_PUBLIC_BASE_URL if you ever move domains.
const PROXY_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://www.x402trustagent.com";

export const EVM_NETWORK = IS_MAINNET ? "eip155:8453" : "eip155:84532"; // Base mainnet / Base Sepolia
export const SVM_NETWORK = IS_MAINNET
  ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" // Solana mainnet-beta
  : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet
const evmChainId = EVM_NETWORK.split(":")[1];

// --- Your receiving wallet addresses -------------------------------------
// Reuses the exact same AgentX402Pay wallets by design (same env var names) -
// set X402_EVM_ADDRESS / X402_SVM_ADDRESS to the same values in this
// project's Vercel env vars. On mainnet there is no hardcoded fallback - a
// missing env var fails loudly at startup instead of silently sending real
// funds nowhere safe.
function requiredMainnetAddress(envVar: string, label: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new Error(
      `${envVar} is not set. On mainnet (X402_NETWORK=mainnet) a real ${label} address is required.`,
    );
  }
  return value;
}

export const evmAddress = IS_MAINNET
  ? requiredMainnetAddress("X402_EVM_ADDRESS", "EVM")
  : process.env.X402_EVM_ADDRESS || "0xB2BDc37b8481F4CdCF38402CFCd446Ae5133BeeF";
export const svmAddress = IS_MAINNET
  ? requiredMainnetAddress("X402_SVM_ADDRESS", "Solana")
  : process.env.X402_SVM_ADDRESS || "7mLNXWECZkQF1UeDeVH57hobgU4cDMCatNHUir3cdCkM";

// --- Facilitator ------------------------------------------------------------
// Testnet: https://x402.org/facilitator (free, testnet-only). Mainnet:
// Coinbase's CDP facilitator, authenticated via CDP_API_KEY_ID /
// CDP_API_KEY_SECRET - same credentials as AgentX402Pay, reuse them here.
//
// Not called eagerly here - Next.js's build step imports every route module,
// which would run this file's top-level code during `next build` too, before
// CDP credentials are guaranteed to be present in that build environment.
// Wrapping it in a lazy proxy defers the real construction (and its
// credential check) to the first actual payment verify/settle call.
function createLazyClient<T extends object>(factory: () => T): T {
  let real: T | undefined;
  function resolve(): T {
    if (!real) real = factory();
    return real;
  }
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const client = resolve();
      const value = Reflect.get(client as object, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

const facilitatorClient = IS_MAINNET
  ? createLazyClient(() => createCdpFacilitatorClient())
  : new HTTPFacilitatorClient({
      url: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator", // Testnet only
    });

export const server = new x402ResourceServer(facilitatorClient);
server.register(EVM_NETWORK, new ExactEvmScheme());
server.register("solana:*", new ExactSvmScheme());

// --- Discovery (Bazaar) -------------------------------------------------------
// Lets buyers and AI agents find this service without a human reading docs
// first - see AgentX402Pay's README ("Discovery & trust") for the full
// picture.
server.registerExtension(bazaarResourceServerExtension);

// --- Signed offers & receipts --------------------------------------------------
// On every 402, signs an "offer" (proof this server proposed those exact
// terms); on every successful payment, signs a "receipt" (proof the service
// was delivered). This is the actual trust mechanism behind the
// "X402 Trust Agent" name - a buyer can hold onto a signed receipt as
// portable, verifiable evidence of a completed transaction.
//
// This signing key never holds funds or submits transactions - it only signs
// off-chain EIP-712 messages. You can reuse AgentX402Pay's
// OFFER_RECEIPT_SIGNER_PRIVATE_KEY value here, or generate a separate one for
// this service's own identity. A testnet fallback key is shipped below
// purely for local `next dev` convenience - override with
// OFFER_RECEIPT_SIGNER_PRIVATE_KEY in any real deployment.
const offerReceiptSigner = privateKeyToAccount(
  (IS_MAINNET
    ? requiredMainnetAddress("OFFER_RECEIPT_SIGNER_PRIVATE_KEY", "offer-receipt signing key")
    : process.env.OFFER_RECEIPT_SIGNER_PRIVATE_KEY ||
      "0x0c2c7bcf4fc83852605e8ed43905a8e0b472c32f5d943931ea11fe2b03a32ecd") as `0x${string}`, // testnet-mode default
);
const offerReceiptIssuer = createEIP712OfferReceiptIssuer(
  `did:pkh:eip155:${evmChainId}:${offerReceiptSigner.address}`,
  (params) => offerReceiptSigner.signTypedData(params),
);
server.registerExtension(createOfferReceiptExtension(offerReceiptIssuer));

// --- Lifecycle hooks (observability) ----------------------------------------
// Pure observers, wired so every payment attempt shows up as a structured,
// greppable line in Vercel's runtime logs, tagged "[x402:...]".
server
  .onBeforeVerify(async (context) => {
    console.log("[x402:verify:start]", {
      scheme: context.requirements.scheme,
      network: context.requirements.network,
      resource: context.paymentPayload.resource?.url,
    });
  })
  .onAfterVerify(async (context) => {
    console.log("[x402:verify:ok]", {
      network: context.requirements.network,
      payer: context.result.payer,
    });
  })
  .onVerifyFailure(async (context) => {
    console.warn("[x402:verify:fail]", {
      network: context.requirements.network,
      error: context.error.message,
    });
  })
  .onBeforeSettle(async (context) => {
    console.log("[x402:settle:start]", {
      network: context.requirements.network,
      phase: context.phase,
    });
  })
  .onAfterSettle(async (context) => {
    console.log("[x402:settle:ok]", {
      network: context.requirements.network,
      phase: context.phase,
      payer: context.result.payer,
      transaction: context.result.transaction,
      amount: context.result.amount ?? context.requirements.amount,
    });
  })
  .onSettleFailure(async (context) => {
    console.error("[x402:settle:fail]", {
      network: context.requirements.network,
      phase: context.phase,
      error: context.error.message,
    });
  });

export { PROXY_BASE_URL };
