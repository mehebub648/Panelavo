import type { NextRequest } from "next/server";
import { executeFederationRequest } from "@/server/fleet/service";
import { readFleetJson } from "@/server/fleet/http";
import type { FleetSignedEnvelope } from "@/server/fleet/types";
import { fail } from "@/server/http";
import { clientKey, rateLimit } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    rateLimit(`fleet-execute:${clientKey(request)}`, 240, 60_000);
    const result = await executeFederationRequest(
      await readFleetJson<FleetSignedEnvelope>(request),
    );
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fail(error);
  }
}
