import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import {
  resolveDnsStatus,
  systemWildcardDomain,
  systemWildcardProbe,
} from "@/server/network/dns";
import { getServerPublicIp } from "@/server/network/server-ip";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";
import { getPanelSettings, setBaseDomain } from "@/server/settings/store";
import { SITE_CATEGORIES } from "@/server/sites/site-meta";
import { normalizeDomain } from "@/schemas/sites";

async function requireSuperAdmin() {
  const session = await requireUser();
  if (session.user.panelRole !== "super-admin")
    throw new AppError("FORBIDDEN", "Panel settings are available to super administrators only.", 403);
  return session;
}

export async function GET() {
  try {
    await requireSuperAdmin();
    const settings = await getPanelSettings();
    const serverIp = await getServerPublicIp();
    const probeName = settings.baseDomain
      ? systemWildcardProbe(serverIp, settings.baseDomain)
      : "";
    const [dns] = probeName ? await resolveDnsStatus([probeName], serverIp) : [null];
    return ok({
      settings,
      dns,
      serverIp,
      wildcardDomain: settings.baseDomain
        ? systemWildcardDomain(serverIp, settings.baseDomain)
        : "",
      categories: SITE_CATEGORIES,
    });
  } catch (error) {
    return fail(error);
  }
}

const updateSchema = z
  .object({
    baseDomain: z
      .string()
      .transform(normalizeDomain)
      .refine(
        (value) =>
          value.length <= 253 &&
          value.split(".").length >= 2 &&
          value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)),
        "Enter a valid domain, such as example.com.",
      )
      .optional(),
  })
  .strict();

export async function PATCH(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireSuperAdmin();
    const input = updateSchema.parse(await request.json());
    if (input.baseDomain !== undefined) await setBaseDomain(input.baseDomain);
    audit("settings.update", "success", { user: session.user.username });
    const settings = await getPanelSettings();
    const serverIp = await getServerPublicIp();
    const probeName = settings.baseDomain
      ? systemWildcardProbe(serverIp, settings.baseDomain)
      : "";
    const [dns] = probeName ? await resolveDnsStatus([probeName], serverIp) : [null];
    return ok({
      settings,
      dns,
      serverIp,
      wildcardDomain: settings.baseDomain
        ? systemWildcardDomain(serverIp, settings.baseDomain)
        : "",
    });
  } catch (error) {
    audit("settings.update", "failure", {});
    return fail(error);
  }
}
