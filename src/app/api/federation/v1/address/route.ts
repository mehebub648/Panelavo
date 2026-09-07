import type { NextRequest } from "next/server";
import { handleAddressEnvelope } from "@/server/fleet/address";
import { readFleetJson } from "@/server/fleet/http";
import type { FleetSignedEnvelope } from "@/server/fleet/types";
import { fail } from "@/server/http";
import { clientKey, rateLimit } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    rateLimit(`fleet-address:${clientKey(request)}`, 60, 60_000);
    return Response.json(
      await handleAddressEnvelope(
        await readFleetJson<FleetSignedEnvelope>(request),
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}
