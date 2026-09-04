import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { getPanelSelfDomain } from "@/server/sites/panel-self";
import type { ServerInfo, ServerInformation } from "@/types/cloudpanel";

function isPublicIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  return (
    isIP(normalized) === 6 &&
    normalized !== "::1" &&
    !normalized.startsWith("fe8") &&
    !normalized.startsWith("fe9") &&
    !normalized.startsWith("fea") &&
    !normalized.startsWith("feb") &&
    !normalized.startsWith("fc") &&
    !normalized.startsWith("fd")
  );
}

export function completeServerInformation(
  info: ServerInfo,
  configuredPanelOrigin?: string,
): ServerInformation {
  const ipv4Addresses = isIP(info.ip) === 4 ? [info.ip] : [];
  const ipv6Addresses = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal && isPublicIpv6(address.address))
    .map((address) => address.address.split("%")[0]);

  return {
    ...info,
    panelAddress:
      configuredPanelOrigin ||
      (getPanelSelfDomain() ? `https://${getPanelSelfDomain()}` : ""),
    ipv4Addresses: [...new Set(ipv4Addresses)],
    ipv6Addresses: [...new Set(ipv6Addresses)],
  };
}
