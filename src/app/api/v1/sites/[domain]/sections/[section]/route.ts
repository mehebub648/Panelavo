import type { NextRequest } from "next/server";
import { authenticateApiToken } from "@/server/auth/api-tokens";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { rateLimit } from "@/server/security/request";
import {
  backupRequestSchema,
  envRequestSchema,
  gitRequestSchema,
  operationsRequestSchema,
} from "@/schemas/operations";
import { getDeployHooks } from "@/server/deploy/hooks";

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
      await getCloudPanelClient().getSiteSection(
        actor.cloudPanel,
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
    const submitted = await request.json();
    const input =
      section === "git"
        ? gitRequestSchema.parse(submitted)
        : section === "actions"
          ? operationsRequestSchema.parse(submitted)
          : section === "env"
            ? envRequestSchema.parse(submitted)
            : section === "backups"
              ? backupRequestSchema.parse(submitted)
              : submitted;
    const decoded = decodeURIComponent(domain);
    if (section === "git" && input.action === "pull")
      await getCloudPanelClient().getSiteSection(
        actor.cloudPanel,
        decoded,
        "git",
      );
    const operation =
      section === "git" && input.action === "pull"
        ? { ...input, deployOperations: await getDeployHooks(decoded) }
        : input;
    const data = await getCloudPanelClient().manageSiteSection(
      actor.cloudPanel,
      decoded,
      section,
      operation,
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
