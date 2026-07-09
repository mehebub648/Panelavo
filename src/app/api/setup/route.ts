import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { getServerPublicIp } from "@/server/network/server-ip";
import { registerWildcard } from "@/server/network/ippointer";
import {
  getSystemStatus,
  invalidateSystemStatus,
} from "@/server/network/system-status";
import { setBaseDomain } from "@/server/settings/store";
import { normalizeDomain } from "@/schemas/sites";

async function requireSuperAdmin() {
  const session = await requireUser();
  if (session.user.panelRole !== "super-admin")
    throw new AppError(
      "FORBIDDEN",
      "Panel setup is available to super administrators only.",
      403,
    );
  return session;
}

// Anyone signed in may read the readiness status (the /setup screen shows it to
// every role); only super admins may change the base domain or register DNS.
export async function GET() {
  try {
    await requireUser();
    return ok({ status: await getSystemStatus({ refresh: true }) });
  } catch (error) {
    return fail(error);
  }
}

const baseDomainValue = z
  .string()
  .transform(normalizeDomain)
  .refine(
    (value) =>
      value.length <= 253 &&
      value.split(".").length >= 2 &&
      value
        .split(".")
        .every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)),
    "Enter a valid domain, such as example.com.",
  );

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("register") }).strict(),
  z
    .object({ action: z.literal("set-base-domain"), baseDomain: baseDomainValue })
    .strict(),
]);

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireSuperAdmin();
    const input = actionSchema.parse(await request.json());

    if (input.action === "set-base-domain") {
      await setBaseDomain(input.baseDomain);
      invalidateSystemStatus();
      audit("setup.base-domain", "success", {
        user: session.user.username,
        domain: input.baseDomain,
      });
      return ok({ status: await getSystemStatus({ refresh: true }) });
    }

    // action === "register"
    rateLimit(`setup-register:${session.user.id}`, 5, 60_000);
    const serverIp = await getServerPublicIp();
    if (!serverIp)
      throw new AppError(
        "INVALID_REQUEST",
        "The server's public IP address could not be determined.",
        409,
      );
    const result = await registerWildcard(serverIp);
    invalidateSystemStatus();
    audit("setup.register", result.ok ? "success" : "failure", {
      user: session.user.username,
      ip: serverIp,
    });
    return ok({
      register: result,
      status: await getSystemStatus({ refresh: true }),
    });
  } catch (error) {
    audit("setup.action", "failure", {});
    return fail(error);
  }
}
