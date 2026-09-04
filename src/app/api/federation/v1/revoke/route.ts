import type { NextRequest } from "next/server";
import { revokeFederationRequest } from "@/server/fleet/service";
import { readFleetJson } from "@/server/fleet/http";
import type { FleetSignedEnvelope } from "@/server/fleet/types";
import { fail, ok } from "@/server/http";
import { clientKey, rateLimit } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    rateLimit(`fleet-revoke:${clientKey(request)}`, 30, 60_000);
    return ok(
      await revokeFederationRequest(
        await readFleetJson<FleetSignedEnvelope>(request),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
