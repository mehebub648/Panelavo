import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";
import { getServerPublicIp } from "@/server/network/server-ip";
import {
  assertDomainsPointToServer,
  resolveDnsStatus,
} from "@/server/network/dns";
import { autoPointDns, autoDeleteDns } from "@/server/network/auto-dns";
import { getSiteMeta, setSiteMeta, type SiteMeta } from "@/server/sites/site-meta";
import { domainValue } from "@/schemas/sites";
import { certAlternativeNames } from "@/lib/domains";

type Context = { params: Promise<{ domain: string }> };

async function requireSite(domain: string) {
  const session = await requireUser();
  const sites = await getCloudPanelClient().listSites(session.record.cloudPanel);
  const site = sites.find((item) => item.domain === domain);
  if (!site) throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  return { session, site };
}

function requireWrite(session: Awaited<ReturnType<typeof requireUser>>) {
  if (!session.user.canCreateSites && session.user.panelRole !== "admin")
    throw new AppError("FORBIDDEN", "You do not have permission to modify websites.", 403);
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    await requireSite(decodedDomain);
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);
    const meta = await getSiteMeta(decodedDomain);
    const dns = await resolveDnsStatus(
      [decodedDomain, ...(meta?.aliases ?? [])],
      serverIp,
    );
    return ok({ meta, serverIp, dns });
  } catch (error) {
    return fail(error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
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
    .object({ action: z.literal("issue-ssl"), domains: z.array(domainValue).max(11) })
    .strict(),
]);

async function syncVhost(
  session: Awaited<ReturnType<typeof requireUser>>,
  domain: string,
  meta: SiteMeta,
) {
  await getCloudPanelClient().manageSiteSection(session.record.cloudPanel, domain, "domains", {
    action: "sync",
    systemDomain: domain,
    aliases: meta.aliases,
    block: meta.aliases.length ? meta.block : "none",
    redirectTo: meta.redirectTo,
  });
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const { session } = await requireSite(decodedDomain);
    requireWrite(session);
    const input = actionSchema.parse(await request.json());
    const meta = await getSiteMeta(decodedDomain);
    if (!meta)
      throw new AppError(
        "INVALID_REQUEST",
        "This website was created outside the panel and has no domain metadata.",
        409,
      );
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);
    const warnings: string[] = [];

    if (input.action === "add-alias") {
      if (input.domain === decodedDomain)
        throw new AppError("INVALID_REQUEST", "The system domain is already served.", 400);
      if (!meta.aliases.includes(input.domain)) meta.aliases.push(input.domain);
      // The vhost is the part that must not silently fail; update meta only
      // after the web server accepted the new alias.
      await syncVhost(session, decodedDomain, meta);
      await setSiteMeta(decodedDomain, meta);

      // Background DNS and SSL automation
      void (async () => {
        try {
          await autoPointDns(session.user.id, input.domain, serverIp);
          // Only attempt SSL if all domains are pointed
          const san = Array.from(
            new Set(
              meta.aliases
                .filter((name) => name !== decodedDomain)
                .flatMap((name) => [name, ...certAlternativeNames(name)]),
            ),
          );
          const domains = Array.from(new Set([decodedDomain, ...san]));
          const statuses = await resolveDnsStatus(domains, serverIp);
          const allPointed = statuses.every(s => s.pointed);
          
          if (allPointed) {
            await getCloudPanelClient().manageSiteSection(
              session.record.cloudPanel,
              decodedDomain,
              "certificates",
              san.length
                ? { action: "lets-encrypt", subjectAlternativeName: san.join(",") }
                : { action: "lets-encrypt" },
            );
          }
        } catch (e: unknown) {
          console.error("Auto DNS/SSL failed for added alias:", e);
        }
      })();
    } else if (input.action === "remove-alias") {
      meta.aliases = meta.aliases.filter((alias) => alias !== input.domain);
      if (meta.redirectTo === input.domain) {
        meta.redirectTo = meta.aliases[0];
        if (meta.block === "redirect" && !meta.redirectTo) meta.block = "none";
      }
      await syncVhost(session, decodedDomain, meta);
      await setSiteMeta(decodedDomain, meta);

      // Background DNS cleanup
      void autoDeleteDns(session.user.id, input.domain, serverIp).catch((e: unknown) => {
        console.error("Auto DNS delete failed for removed alias:", e);
      });
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
          ? (input.redirectTo && meta.aliases.includes(input.redirectTo)
              ? input.redirectTo
              : meta.aliases[0])
          : undefined;
      await syncVhost(session, decodedDomain, meta);
      await setSiteMeta(decodedDomain, meta);
    } else if (input.action === "issue-ssl") {
      const allowed = new Set([decodedDomain, ...meta.aliases]);
      const requested = input.domains.filter((name) => allowed.has(name));
      if (!requested.length)
        throw new AppError("INVALID_REQUEST", "Select at least one domain of this website.", 400);
      // Primary must be the system domain (the vhost/certificate name);
      // everything else, plus conventional www companions, goes in the SAN.
      const san = Array.from(
        new Set(
          requested
            .filter((name) => name !== decodedDomain)
            .flatMap((name) => [name, ...certAlternativeNames(name)]),
        ),
      );
      await assertDomainsPointToServer(
        Array.from(new Set([decodedDomain, ...san])),
        serverIp,
        (status) =>
          `${status.name} must point to this server (${serverIp}) before a certificate can be issued.`,
      );
      await getCloudPanelClient().manageSiteSection(
        session.record.cloudPanel,
        decodedDomain,
        "certificates",
        san.length
          ? { action: "lets-encrypt", subjectAlternativeName: san.join(",") }
          : { action: "lets-encrypt" },
      );
    }

    audit("sites.domains", "success", {
      user: session.user.username,
      domain: decodedDomain,
      action: input.action,
    });
    const dns = await resolveDnsStatus([decodedDomain, ...meta.aliases], serverIp);
    return ok({ meta: await getSiteMeta(decodedDomain), serverIp, dns, warnings });
  } catch (error) {
    audit("sites.domains", "failure", {});
    return fail(error);
  }
}
