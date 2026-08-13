import type { NextRequest } from "next/server";
import { authenticateApiToken } from "@/server/auth/api-tokens";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { rateLimit } from "@/server/security/request";
import type { PanelActor } from "@/server/auth/site-access";
import {
  getSiteSectionForActor,
  manageSiteSectionForActor,
} from "@/server/sites/site-section-service";

function panelActor(
  actor: Awaited<ReturnType<typeof authenticateApiToken>>,
): PanelActor {
  return {
    user: actor.user,
    cloudPanel: actor.cloudPanel,
    authentication: "api-token",
    credentialId: actor.id,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    const { domain, section } = await params;
    if (section === "terminal")
      throw new AppError(
        "FORBIDDEN",
        "The automation API does not expose Terminal.",
        403,
      );
    const actor = await authenticateApiToken(
      request,
      section === "env" ? "sites:write" : "sites:read",
    );
    rateLimit(`api-token:${actor.id}`, 120, 60_000);
    return ok(
      await getSiteSectionForActor(
        panelActor(actor),
        decodeURIComponent(domain),
        section,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    const actor = await authenticateApiToken(request, "sites:write");
    rateLimit(`api-token:${actor.id}`, 30, 60_000);
    const { domain, section } = await params;
    if (section === "terminal")
      throw new AppError(
        "FORBIDDEN",
        "The automation API does not expose Terminal.",
        403,
      );
    const decoded = decodeURIComponent(domain);
    const data = await manageSiteSectionForActor(
      panelActor(actor),
      decoded,
      section,
      await request.json(),
    );
    await audit("api.site_section.mutated", "success", {
      actor: actor.user,
      target: { type: "site", id: decoded },
      details: { section, tokenId: actor.id },
    });
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
