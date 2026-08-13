import { Resolver } from "node:dns/promises";
import { z } from "zod";
import { certAlternativeNames } from "@/lib/domains";
import { domainValue } from "@/schemas/sites";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleDomainTargetForActor,
  accessibleSiteForActor,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { pointDns, pointDnsError } from "@/server/cloudflare/point-dns";
import { getZones } from "@/server/cloudflare/store";
import { AppError } from "@/server/cloudpanel/errors";
import { autoDeleteDns } from "@/server/network/auto-dns";
import {
  assertDomainsPointToServer,
  resolveDnsStatus,
} from "@/server/network/dns";
import {
  certificateAlreadyCovers,
  issueSiteSsl,
  planSiteSsl,
} from "@/server/sites/ensure-ssl";
import {
  getSiteMeta,
  setSiteMeta,
  type SiteMeta,
} from "@/server/sites/site-meta";

export const siteDomainActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add-alias"), domain: domainValue }).strict(),
  z.object({ action: z.literal("remove-alias"), domain: domainValue }).strict(),
  z
    .object({
      action: z.literal("set-block"),
      block: z.enum(["none", "error", "redirect"]),
      redirectTo: domainValue.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("issue-ssl"),
      domains: z.array(domainValue).max(11),
    })
    .strict(),
  z.object({ action: z.literal("ensure-ssl") }).strict(),
]);

export const pointSiteDnsSchema = z
  .object({
    credentialId: z.string().min(1).max(128),
    zoneId: z.string().min(1).max(128),
    replace: z.boolean().optional(),
    proxied: z.boolean().optional(),
  })
  .strict();

export type SiteDomainAction = z.infer<typeof siteDomainActionSchema>;
export type PointSiteDnsInput = z.infer<typeof pointSiteDnsSchema>;

async function syncVhost(actor: PanelActor, domain: string, meta: SiteMeta) {
  await writableSiteForActor(actor, domain).then(({ client }) =>
    client.manageSiteSection(actor.cloudPanel, domain, "domains", {
      action: "sync",
      systemDomain: domain,
      aliases: meta.aliases,
      block: meta.aliases.length ? meta.block : "none",
      redirectTo: meta.redirectTo,
    }),
  );
}

export async function getSiteDomainsForActor(
  actor: PanelActor,
  requestedDomain: string,
  serverIp: string,
) {
  const { site } = await accessibleSiteForActor(actor, requestedDomain);
  const domain = site.domain;
  const meta = await getSiteMeta(domain);
  const dns = await resolveDnsStatus(
    [domain, ...(meta?.aliases ?? [])],
    serverIp,
  );
  return { meta, serverIp, dns };
}

export async function manageSiteDomainsForActor(
  actor: PanelActor,
  requestedDomain: string,
  submitted: unknown,
  serverIp: string,
) {
  const { site, client } = await writableSiteForActor(actor, requestedDomain);
  const domain = site.domain;
  const input = siteDomainActionSchema.parse(submitted);
  const meta = await getSiteMeta(domain);
  if (!meta)
    throw new AppError(
      "INVALID_REQUEST",
      "This website was created outside the panel and has no domain metadata.",
      409,
    );
  const warnings: string[] = [];

  if (input.action === "add-alias") {
    if (input.domain === domain)
      throw new AppError(
        "INVALID_REQUEST",
        "The system domain is already served.",
        400,
      );
    if (!meta.aliases.includes(input.domain)) meta.aliases.push(input.domain);
    await syncVhost(actor, domain, meta);
    await setSiteMeta(domain, meta);

    const plan = await planSiteSsl({
      userId: actor.user.id,
      systemDomain: domain,
      aliases: meta.aliases,
      serverIp,
      autoPoint: true,
    });
    warnings.push(...plan.warnings);
    void issueSiteSsl(actor.cloudPanel, domain, plan.san).catch(
      (error: unknown) => {
        console.error(`Let's Encrypt issuance failed for ${domain}:`, error);
      },
    );
  } else if (input.action === "remove-alias") {
    if (!meta.aliases.includes(input.domain))
      throw new AppError(
        "INVALID_REQUEST",
        "That domain is not an alias of this website.",
        400,
      );
    meta.aliases = meta.aliases.filter((alias) => alias !== input.domain);
    if (meta.redirectTo === input.domain) {
      meta.redirectTo = meta.aliases[0];
      if (meta.block === "redirect" && !meta.redirectTo) meta.block = "none";
    }
    await syncVhost(actor, domain, meta);
    await setSiteMeta(domain, meta);

    void autoDeleteDns(actor.user.id, input.domain, serverIp).catch(
      (error: unknown) => {
        console.error("Auto DNS delete failed for removed alias:", error);
      },
    );
  } else if (input.action === "set-block") {
    if (input.block !== "none" && !meta.aliases.length)
      throw new AppError(
        "INVALID_REQUEST",
        "Add at least one of your own domains before blocking the system domain.",
        400,
      );
    meta.block = input.block;
    meta.redirectTo =
      input.block === "redirect"
        ? input.redirectTo && meta.aliases.includes(input.redirectTo)
          ? input.redirectTo
          : meta.aliases[0]
        : undefined;
    await syncVhost(actor, domain, meta);
    await setSiteMeta(domain, meta);
  } else if (input.action === "issue-ssl") {
    const allowed = new Set([domain, ...meta.aliases]);
    const requested = input.domains.filter((name) => allowed.has(name));
    if (!requested.length)
      throw new AppError(
        "INVALID_REQUEST",
        "Select at least one domain of this website.",
        400,
      );
    const san = Array.from(
      new Set(
        requested
          .filter((name) => name !== domain)
          .flatMap((name) => [name, ...certAlternativeNames(name)]),
      ),
    );
    await assertDomainsPointToServer(
      Array.from(new Set([domain, ...san])),
      serverIp,
      (status) =>
        `${status.name} must point to this server (${serverIp}) before a certificate can be issued.`,
    );
    await client.manageSiteSection(
      actor.cloudPanel,
      domain,
      "certificates",
      san.length
        ? { action: "lets-encrypt", subjectAlternativeName: san.join(",") }
        : { action: "lets-encrypt" },
    );
  } else {
    const plan = await planSiteSsl({
      userId: actor.user.id,
      systemDomain: domain,
      aliases: meta.aliases,
      serverIp,
      autoPoint: true,
    });
    warnings.push(...plan.warnings);
    const desired = [domain, ...plan.san];
    if (await certificateAlreadyCovers(actor.cloudPanel, domain, desired)) {
      warnings.push(
        "The installed certificate already covers every domain that points here.",
      );
    } else {
      await issueSiteSsl(actor.cloudPanel, domain, plan.san);
    }
  }

  const dns = await resolveDnsStatus([domain, ...meta.aliases], serverIp);
  return {
    meta: await getSiteMeta(domain),
    serverIp,
    dns,
    warnings,
  };
}

export async function getSiteDnsForActor(
  actor: PanelActor,
  requestedDomain: string,
  serverIp: string,
) {
  const { target } = await accessibleDomainTargetForActor(
    actor,
    requestedDomain,
  );
  let ip: string | null = null;
  let pointed = false;
  try {
    const resolver = new Resolver();
    resolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
    const records = await resolver.resolve4(target);
    ip = records[0] ?? null;
    pointed = ip === serverIp;
  } catch {
    pointed = false;
  }

  let matchZone: Awaited<ReturnType<typeof getZones>>["zones"][number] | null =
    null;
  try {
    const { zones } = await getZones(actor.user.id);
    matchZone =
      zones.find(
        (zone) => target === zone.name || target.endsWith(`.${zone.name}`),
      ) ?? null;
  } catch {
    // A missing Cloudflare connection does not prevent public DNS inspection.
  }

  return {
    pointed,
    ip,
    serverIp,
    zoneId: matchZone?.id ?? null,
    credentialId: matchZone?.credentialId ?? null,
  };
}

export async function pointSiteDnsForActor(
  actor: PanelActor,
  requestedDomain: string,
  submitted: unknown,
  serverIp: string,
) {
  const { target } = await accessibleDomainTargetForActor(
    actor,
    requestedDomain,
    { write: true },
  );
  const input = pointSiteDnsSchema.parse(submitted);
  const outcome = await pointDns({
    userId: actor.user.id,
    domain: target,
    serverIp,
    credentialId: input.credentialId,
    zoneId: input.zoneId,
    replace: input.replace === true,
    proxied: input.proxied === true,
  });
  if (!outcome.primaryOk) throw pointDnsError(outcome);
  const records = outcome.outcomes.flatMap((item) =>
    item.record ? [item.record] : [],
  );
  return {
    records,
    record: records[0],
    changed: outcome.changed,
  };
}
