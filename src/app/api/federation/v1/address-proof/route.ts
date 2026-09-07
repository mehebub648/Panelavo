import type { NextRequest } from "next/server";
import { z } from "zod";
import { answerAddressProof } from "@/server/fleet/address";
import { readFleetJson } from "@/server/fleet/http";
import { fail, ok } from "@/server/http";
import { clientKey, rateLimit } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    rateLimit(`fleet-address-proof:${clientKey(request)}`, 30, 60_000);
    const input = z
      .object({ challenge: z.string().min(40).max(100) })
      .strict()
      .parse(await readFleetJson(request));
    return ok(answerAddressProof(input.challenge));
  } catch (error) {
    return fail(error);
  }
}
