import type { NextRequest } from "next/server";
import { acceptFleetEnrollment } from "@/server/fleet/service";
import { readFleetJson } from "@/server/fleet/http";
import { fail, ok } from "@/server/http";
import { clientKey, rateLimit } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    rateLimit(`fleet-enroll:${clientKey(request)}`, 10, 10 * 60_000);
    return ok(await acceptFleetEnrollment(await readFleetJson(request)), {
      status: 201,
    });
  } catch (error) {
    return fail(error);
  }
}
