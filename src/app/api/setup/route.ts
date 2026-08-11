import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSystemStatus,
  invalidateSystemStatus,
} from "@/server/network/system-status";
import { setAddressSettings, setBaseDomain } from "@/server/settings/store";
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

const actionSchema = z.union([
  z.object({ action: z.literal("configure-address"), addressMode: z.literal("sslip") }).strict(),
  z.object({ action: z.literal("configure-address"), addressMode: z.literal("custom"), baseDomain: baseDomainValue }).strict(),
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
    await setAddressSettings(
      input.addressMode,
      input.addressMode === "sslip" ? "sslip.io" : input.baseDomain,
    );
    invalidateSystemStatus();
    audit("setup.address", "success", {
      user: session.user.username,
      addressMode: input.addressMode,
    });
    return ok({ status: await getSystemStatus({ refresh: true }) });
  } catch (error) {
    audit("setup.action", "failure", {});
    return fail(error);
  }
}
