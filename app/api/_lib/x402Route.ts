import { NextRequest, NextResponse } from "next/server";
import { withX402FromHTTPServer, x402HTTPResourceServer, type RouteConfig } from "@x402/next";
import type { RoutesConfig } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { declareOfferReceiptExtension } from "@x402/extensions/offer-receipt";
import { server, evmAddress, svmAddress, EVM_NETWORK, SVM_NETWORK, PROXY_BASE_URL } from "../../../proxy";

// Same shared-scaffolding pattern as AgentX402Pay's app/api/_lib/x402Route.ts
// - each route file only defines its own logic plus a small metadata object.

export class RouteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type DiscoveryOptions = Parameters<typeof declareDiscoveryExtension>[0];

export type X402RouteConfig = {
  handler: (request: NextRequest) => Promise<NextResponse> | NextResponse;
  resource: string;
  description: string;
  /** e.g. "$0.05" */
  price: string;
  serviceName: string;
  tags: string[];
  discovery: DiscoveryOptions;
};

export const BASE_URL = PROXY_BASE_URL;
const ICON_URL = `${BASE_URL}/icon.png`;

export function createX402Route(config: X402RouteConfig) {
  const wrapped = async (request: NextRequest): Promise<NextResponse> => {
    try {
      return await config.handler(request);
    } catch (err) {
      const status = err instanceof RouteError ? err.status : 500;
      const message =
        err instanceof RouteError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      return NextResponse.json({ error: message }, { status });
    }
  };

  const routeConfig: RouteConfig = {
    accepts: [
      { scheme: "exact" as const, price: config.price, network: EVM_NETWORK, payTo: evmAddress },
      { scheme: "exact" as const, price: config.price, network: SVM_NETWORK, payTo: svmAddress },
    ],
    resource: `${BASE_URL}${config.resource}`,
    description: config.description,
    mimeType: "application/json",
    serviceName: config.serviceName,
    tags: config.tags,
    iconUrl: ICON_URL,
    extensions: {
      ...declareDiscoveryExtension(config.discovery),
      ...declareOfferReceiptExtension({ includeTxHash: true }),
    },
  };

  const routes: RoutesConfig = { [config.resource]: routeConfig };
  const httpServer = new x402HTTPResourceServer(server, routes);
  return withX402FromHTTPServer(wrapped, httpServer);
}

// --- Small shared request-parsing helpers used by several routes -----------

export function requireParam(request: NextRequest, name: string): string {
  const value = request.nextUrl.searchParams.get(name)?.trim();
  if (!value) {
    throw new RouteError(`Missing required query parameter "${name}"`, 400);
  }
  return value;
}

export function optionalParam(request: NextRequest, name: string, fallback: string): string {
  const value = request.nextUrl.searchParams.get(name)?.trim();
  return value || fallback;
}
