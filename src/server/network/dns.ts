import { setDefaultResultOrder } from "node:dns";
import { Resolver } from "node:dns/promises";
import { AppError } from "@/server/cloudpanel/errors";

setDefaultResultOrder("ipv4first");

const fastResolver = new Resolver();
fastResolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

export type DnsStatus = {
  name: string;
  ip: string | null;
  ips: string[];
  pointed: boolean;
};

function withTimeout<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("DNS lookup timed out")), ms),
    ),
  ]);
}

export function systemWildcardDomain(serverIp: string, baseDomain: string) {
  return `*.${serverIp}.${baseDomain}`.toLowerCase();
}

export function systemWildcardProbe(serverIp: string, baseDomain: string) {
  return `site-20001.${serverIp}.${baseDomain}`.toLowerCase();
}

export async function resolveDnsStatus(
  names: string[],
  serverIp: string,
): Promise<DnsStatus[]> {
  return Promise.all(
    names.map(async (name) => {
      try {
        const ips = await withTimeout(fastResolver.resolve4(name));
        return { name, ip: ips[0] ?? null, ips, pointed: ips.includes(serverIp) };
      } catch {
        return { name, ip: null, ips: [], pointed: false };
      }
    }),
  );
}

export async function assertDomainsPointToServer(
  names: string[],
  serverIp: string,
  messageFor?: (status: DnsStatus) => string,
) {
  const statuses = await resolveDnsStatus(names, serverIp);
  const failing = statuses.find((status) => !status.pointed);
  if (!failing) return statuses;
  throw new AppError(
    "INVALID_REQUEST",
    messageFor?.(failing) ??
      `${failing.name} must point to this server (${serverIp}) before continuing.`,
    409,
  );
}

let wildcardVerified = false;
let wildcardLastChecked = 0;

export async function isWildcardConfigured(serverIp: string, baseDomain: string): Promise<boolean> {
  // If verified within the last hour, assume it's still good.
  if (wildcardVerified && Date.now() - wildcardLastChecked < 3600_000) return true;
  
  // Rate limit failed checks to once every 10 seconds.
  if (Date.now() - wildcardLastChecked < 10_000) return false;

  wildcardLastChecked = Date.now();
  const probe = systemWildcardProbe(serverIp, baseDomain);
  const statuses = await resolveDnsStatus([probe], serverIp);
  const pointed = statuses[0]?.pointed ?? false;
  
  if (pointed) wildcardVerified = true;
  return pointed;
}
