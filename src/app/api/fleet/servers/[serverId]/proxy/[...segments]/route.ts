import type { NextRequest } from "next/server";
import { panelActorFromSession } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import { dispatchFleetAction } from "@/server/fleet/service";
import type { FleetActionName } from "@/server/fleet/types";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

type Context = { params: Promise<{ serverId: string; segments: string[] }> };

async function body(request: NextRequest) {
  if (["GET", "HEAD"].includes(request.method)) return undefined;
  assertWriteRequest(request);
  return request.json();
}

function mapped(
  method: string,
  segments: string[],
  submitted: unknown,
  searchParams: URLSearchParams,
): { action: FleetActionName; input?: unknown; status?: number } {
  if (segments[0] === "api") segments = segments.slice(1);
  const [root, first, second, third] = segments.map(decodeURIComponent);
  if (root === "sites" && !first) {
    if (method === "GET") return { action: "sites.list" };
    if (method === "POST")
      return { action: "sites.create", input: submitted, status: 201 };
  }
  if (root === "sites" && first === "options" && method === "GET")
    return { action: "sites.creation-details" };
  if (root === "sites" && first && !second) {
    if (method === "GET")
      return { action: "site.get", input: { domain: first } };
    if (method === "PATCH")
      return {
        action: "site.update",
        input: { domain: first, data: submitted },
      };
    if (method === "DELETE")
      return {
        action: "site.delete",
        input: { domain: first, ...((submitted as object) ?? {}) },
      };
  }
  if (root === "sites" && first && second === "sections" && third) {
    if (method === "GET")
      return {
        action: "site.section.get",
        input: { domain: first, section: third },
      };
    if (method === "POST")
      return {
        action: "site.section.manage",
        input: { domain: first, section: third, data: submitted },
      };
  }
  if (root === "sites" && first && second === "domains") {
    if (method === "GET")
      return { action: "site.domains.get", input: { domain: first } };
    if (method === "POST")
      return {
        action: "site.domains.manage",
        input: { domain: first, data: submitted },
      };
  }
  if (root === "sites" && first && second === "dns") {
    if (method === "GET")
      return { action: "site.dns.get", input: { domain: first } };
    if (method === "POST")
      return {
        action: "site.dns.manage",
        input: { domain: first, data: submitted },
      };
  }
  if (root === "sites" && first && second === "uptime") {
    if (method === "GET")
      return { action: "site.uptime.get", input: { domain: first } };
    if (method === "PUT")
      return {
        action: "site.uptime.save",
        input: { domain: first, data: submitted },
      };
  }
  if (root === "sites" && first && second === "deploy-hooks") {
    if (method === "GET")
      return { action: "site.deploy-hooks.get", input: { domain: first } };
    if (method === "PUT")
      return {
        action: "site.deploy-hooks.save",
        input: {
          domain: first,
          hooks: (submitted as { hooks?: unknown })?.hooks,
        },
      };
  }
  if (root === "sites" && first && second === "services" && !third) {
    if (method === "GET")
      return { action: "site.services.list", input: { domain: first } };
    if (method === "POST")
      return {
        action: "site.services.create",
        input: { domain: first, data: submitted },
        status: 201,
      };
  }
  if (root === "sites" && first && second === "services" && third) {
    if (method === "POST")
      return {
        action: "site.service.verify",
        input: { domain: first, serviceDomain: third },
      };
    if (method === "PATCH")
      return {
        action: "site.service.update",
        input: { domain: first, serviceDomain: third, data: submitted },
      };
    if (method === "DELETE")
      return {
        action: "site.service.delete",
        input: {
          domain: first,
          serviceDomain: third,
          ...((submitted as object) ?? {}),
        },
      };
  }
  if (
    root === "sites" &&
    first &&
    second === "backups" &&
    third === "schedule"
  ) {
    if (method === "GET")
      return { action: "site.backup-automation.get", input: { domain: first } };
    if (method === "PUT")
      return {
        action: "site.backup-schedule.save",
        input: { domain: first, data: submitted },
      };
  }
  if (
    root === "sites" &&
    first &&
    second === "backups" &&
    third === "offsite"
  ) {
    if (method === "GET")
      return { action: "site.backup-automation.get", input: { domain: first } };
    if (method === "PUT")
      return {
        action: "site.offsite.save",
        input: { domain: first, data: submitted },
      };
    if (method === "POST")
      return {
        action: "site.offsite.manage",
        input: {
          domain: first,
          operation: (submitted as { action?: unknown })?.action,
          id: (submitted as { id?: unknown })?.id,
        },
      };
    if (method === "DELETE")
      return { action: "site.offsite.remove", input: { domain: first } };
  }
  if (root === "server" && first === "resources" && method === "GET")
    return { action: "system.resources" };
  if (root === "server" && first === "storage" && !second)
    return {
      action: method === "POST" ? "system.storage.refresh" : "system.storage",
    };
  if (
    root === "server" &&
    first === "storage" &&
    second === "reclaim" &&
    method === "POST"
  )
    return { action: "system.storage.reclaim", input: submitted };
  if (root === "vpn")
    return {
      action: method === "GET" ? "vpn.get" : "vpn.manage",
      input: submitted,
    };
  if (root === "users")
    return {
      action: method === "GET" ? "users.list" : "users.manage",
      input: submitted,
    };
  if (root === "audit" && method === "GET")
    return { action: "audit.list", input: Object.fromEntries(searchParams) };
  if (root === "updates")
    return {
      action: method === "GET" ? "system.update.get" : "system.update.start",
      input: submitted,
    };
  throw new AppError(
    "INVALID_REQUEST",
    "That Fleet route is not available.",
    404,
  );
}

async function handle(request: NextRequest, context: Context) {
  try {
    const session = await requireFleetSuperAdmin({
      allowDuringUpdate: request.method === "GET",
    });
    rateLimit(`fleet-proxy:${session.user.id}`, 300, 60_000);
    const params = await context.params;
    const mapping = mapped(
      request.method,
      params.segments,
      await body(request),
      request.nextUrl.searchParams,
    );
    const result = await dispatchFleetAction(
      params.serverId,
      mapping.action,
      mapping.input,
      panelActorFromSession(session),
    );
    return ok(result, mapping.status ? { status: mapping.status } : undefined);
  } catch (error) {
    return fail(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
