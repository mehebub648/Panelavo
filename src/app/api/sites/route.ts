import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { createSiteSchema } from "@/schemas/sites";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";
import {
  allocateSiteId,
  getAllSiteMeta,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  systemDomainFor,
} from "@/server/sites/site-meta";
import type { CreateSiteInput } from "@/types/cloudpanel";

export async function GET() {
  const requestId = randomUUID();
  try {
    const session = await requireUser();
    const [sites, meta] = await Promise.all([
      getCloudPanelClient().listSites(session.record.cloudPanel),
      getAllSiteMeta(),
    ]);
    return ok({
      sites: sites.map((site) => {
        const siteMeta = meta[site.domain.toLowerCase()];
        return siteMeta ? { ...site, meta: siteMeta } : site;
      }),
    });
  } catch (error) {
    audit("sites.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000);
    if (!session.user.canCreateSites)
      throw new AppError("FORBIDDEN", "You do not have permission to create websites.", 403);
    const input = createSiteSchema.parse(await request.json());

    const baseDomain = await getBaseDomain();
    if (!baseDomain)
      throw new AppError(
        "INVALID_REQUEST",
        "No base domain is configured. Set one on the panel Settings page first.",
        409,
      );
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp))
      throw new AppError(
        "INVALID_REQUEST",
        "The server's public IPv4 address could not be detected. Set SERVER_PUBLIC_IP.",
        503,
      );

    const client = getCloudPanelClient();
    // Ports already used outside the meta store (e.g. sites created before the
    // id scheme or directly in CloudPanel).
    const existingSites = await client.listSites(session.record.cloudPanel);
    const externalPorts = existingSites
      .map((site) => site.appPort)
      .filter((port): port is number => typeof port === "number");
    const { id, category } = await allocateSiteId(input.category, externalPorts);

    const domain = systemDomainFor(id, serverIp, baseDomain);
    const siteUser = siteUserForId(id);
    const aliases = Array.from(
      new Set(input.aliases.filter((alias) => alias !== domain)),
    );

    if (aliases.length > 0) {
      const { assertDomainsPointToServer } = await import("@/server/network/dns");
      await assertDomainsPointToServer(aliases, serverIp);
    }

    const shared = { domain, siteUser, siteUserPassword: input.siteUserPassword };
    const createInput: CreateSiteInput =
      input.type === "php"
        ? { type: "php", ...shared, phpVersion: input.phpVersion, vhostTemplate: input.vhostTemplate }
        : input.type === "nodejs"
          ? { type: "nodejs", ...shared, nodeVersion: input.nodeVersion, appPort: id }
          : input.type === "python"
            ? { type: "python", ...shared, pythonVersion: input.pythonVersion, appPort: id }
            : input.type === "reverse-proxy"
              ? { type: "reverse-proxy", ...shared, reverseProxyUrl: input.reverseProxyUrl }
              : input.type === "docker"
                ? { type: "docker", ...shared, appPort: id }
                : { type: "static", ...shared };

    audit("sites.create.request", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain,
      siteId: id,
      category: category.id,
    });

    const site = await client.createSite(session.record.cloudPanel, createInput);
    const warnings: string[] = [];
    try {
      // Panel admins are restricted CloudPanel users: assign the new site to
      // them immediately so it appears in (and stays limited to) their list.
      if (session.user.panelRole === "admin")
        await client.assignSite(session.record.cloudPanel, domain);
      await setSiteMeta(domain, { id, category: category.id, aliases, block: "none" });
    } catch (error) {
      await client.deleteSite(session.record.cloudPanel, domain).catch(() => undefined);
      await removeSiteMeta(domain).catch(() => undefined);
      throw error;
    }

    // Best-effort automation: DNS for any aliases we can
    // manage, then the alias vhost sync. Failures are reported as warnings
    // instead of rolling back the created site.
    for (const alias of aliases) {
      warnings.push(`Point ${alias} to ${serverIp} at your DNS provider, then issue SSL from the Domains tab.`);
    }
    if (aliases.length) {
      try {
        await client.manageSiteSection(session.record.cloudPanel, domain, "domains", {
          action: "sync",
          systemDomain: domain,
          aliases,
          block: "none",
        });
      } catch {
        warnings.push(
          "The alias domains were saved but could not be added to the web server config yet — open the Domains tab and retry.",
        );
      }
    }

    audit("sites.create", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain,
      siteId: id,
    });
    return ok(
      { site: { ...site, meta: { id, category: category.id, aliases, block: "none" } }, warnings },
      { status: 201 },
    );
  } catch (error) {
    audit("sites.create", "failure", { requestId });
    return fail(error);
  }
}
