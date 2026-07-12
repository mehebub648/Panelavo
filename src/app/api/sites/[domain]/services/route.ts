import { randomInt, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { createLinkedServiceSchema } from "@/schemas/sites";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";
import {
  allocateSiteId,
  getAllSiteMeta,
  getLinkedServiceMeta,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  systemDomainFor,
} from "@/server/sites/site-meta";
import { issueSiteSsl, planSiteSsl } from "@/server/sites/ensure-ssl";

type Context = { params: Promise<{ domain: string }> };

// Linked-service site users are proxy-only: nobody logs into them, so the
// password is generated here and discarded. CloudPanel can reset it later if
// shell access is ever needed.
function makeSiteUserPassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+=_-";
  return Array.from({ length: 24 }, () => chars[randomInt(chars.length)]).join(
    "",
  );
}

export async function GET(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    const session = await requireUser();
    const parentDomain = decodeURIComponent(
      (await context.params).domain,
    ).toLowerCase();
    const [sites, children] = await Promise.all([
      getCloudPanelClient().listSites(session.record.cloudPanel),
      getLinkedServiceMeta(parentDomain),
    ]);
    // The parent must be one of the caller's own sites before its linked
    // services (which panel admins may not have assigned) are revealed.
    if (!sites.some((site) => site.domain.toLowerCase() === parentDomain))
      throw new AppError("SITE_NOT_FOUND", "This website was not found.", 404);
    const services = Object.entries(children).map(([domain, meta]) => {
      const site = sites.find((item) => item.domain.toLowerCase() === domain);
      return {
        domain,
        serviceName: meta.serviceName ?? domain,
        aliases: meta.aliases,
        reverseProxyUrl: site?.reverseProxyUrl,
        status: site?.status,
        accessible: Boolean(site),
      };
    });
    return ok({ services });
  } catch (error) {
    audit("sites.services.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000);
    if (!session.user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    const parentDomain = decodeURIComponent(
      (await context.params).domain,
    ).toLowerCase();
    const input = createLinkedServiceSchema.parse(await request.json());

    const baseDomain = await getBaseDomain();
    if (!baseDomain)
      throw new AppError(
        "INVALID_REQUEST",
        "No base domain is configured. Set one on the panel Settings page first.",
        409,
      );
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(
      forwarded || request.nextUrl.hostname,
    );
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp))
      throw new AppError(
        "INVALID_REQUEST",
        "The server's public IPv4 address could not be detected. Set SERVER_PUBLIC_IP.",
        503,
      );

    const client = getCloudPanelClient();
    const sites = await client.listSites(session.record.cloudPanel);
    const parent = sites.find(
      (site) => site.domain.toLowerCase() === parentDomain,
    );
    if (!parent)
      throw new AppError("SITE_NOT_FOUND", "This website was not found.", 404);
    const allMeta = await getAllSiteMeta();
    const parentMeta = allMeta[parentDomain];
    if (!parentMeta)
      throw new AppError(
        "INVALID_REQUEST",
        "Linked services are only available for panel-created websites.",
        409,
      );
    if (parentMeta.parent)
      throw new AppError(
        "INVALID_REQUEST",
        "A linked service cannot have services of its own. Add it to the parent website instead.",
        400,
      );
    const siblings = await getLinkedServiceMeta(parentDomain);
    if (
      Object.values(siblings).some(
        (meta) => meta.serviceName === input.serviceName,
      )
    )
      throw new AppError(
        "INVALID_REQUEST",
        `A linked service named "${input.serviceName}" already exists for this website.`,
        409,
      );

    // The target must be a port the parent's own stack exposes — never a port
    // reserved by (or serving) a different site.
    const externalPorts = sites
      .map((site) => site.appPort)
      .filter((port): port is number => typeof port === "number");
    const foreignPorts = new Set([
      ...Object.entries(allMeta)
        .filter(([domain]) => domain !== parentDomain)
        .map(([, meta]) => meta.id),
      ...sites
        .filter((site) => site.domain.toLowerCase() !== parentDomain)
        .map((site) => site.appPort)
        .filter((port): port is number => typeof port === "number"),
    ]);
    if (foreignPorts.has(input.targetPort))
      throw new AppError(
        "INVALID_REQUEST",
        `Port ${input.targetPort} is reserved by another website. Point the service at a port this website's own stack exposes.`,
        409,
      );

    const { id, category } = await allocateSiteId(
      parentMeta.category,
      externalPorts,
    );
    const domain = systemDomainFor(id, serverIp, baseDomain);
    const aliases = Array.from(
      new Set(input.aliases.filter((alias) => alias !== domain)),
    );

    audit("sites.services.create.request", "success", {
      requestId,
      user: session.user.username,
      parent: parentDomain,
      serviceName: input.serviceName,
      domain,
      siteId: id,
      targetPort: input.targetPort,
    });

    const site = await client.createSite(session.record.cloudPanel, {
      type: "reverse-proxy",
      domain,
      siteUser: siteUserForId(id),
      siteUserPassword: makeSiteUserPassword(),
      reverseProxyUrl: `http://127.0.0.1:${input.targetPort}`,
    });
    const warnings: string[] = [];
    const meta = {
      id,
      category: category.id,
      aliases,
      block: "none" as const,
      parent: parentDomain,
      serviceName: input.serviceName,
    };
    try {
      if (session.user.panelRole === "admin")
        await client.assignSite(session.record.cloudPanel, domain);
      await setSiteMeta(domain, meta);
    } catch (error) {
      await client
        .deleteSite(session.record.cloudPanel, domain)
        .catch(() => undefined);
      await removeSiteMeta(domain).catch(() => undefined);
      throw error;
    }

    if (aliases.length) {
      try {
        await client.manageSiteSection(
          session.record.cloudPanel,
          domain,
          "domains",
          { action: "sync", systemDomain: domain, aliases, block: "none" },
        );
      } catch {
        warnings.push(
          "The service was created, but failed to configure its domain aliases. Try saving them again from the service's Settings tab.",
        );
      }
    }

    const plan = await planSiteSsl({
      userId: session.user.id,
      systemDomain: domain,
      aliases,
      serverIp,
      autoPoint: true,
    });
    warnings.push(...plan.warnings);
    void issueSiteSsl(session.record.cloudPanel, domain, plan.san).catch(
      (error: unknown) => {
        console.error(
          `Let's Encrypt issuance failed for linked service ${domain}:`,
          error,
        );
      },
    );

    audit("sites.services.create", "success", {
      requestId,
      user: session.user.username,
      parent: parentDomain,
      serviceName: input.serviceName,
      domain,
      siteId: id,
    });
    return ok({ site: { ...site, meta }, warnings }, { status: 201 });
  } catch (error) {
    audit("sites.services.create", "failure", { requestId });
    return fail(error);
  }
}
