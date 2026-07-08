import { networkInterfaces } from "node:os";

// Detect the server's public IPv4 address dynamically so the panel needs no
// per-install configuration. Resolution order:
//   1. SERVER_PUBLIC_IP env var (explicit override, if an operator sets one)
//   2. an external echo service (authoritative for the real public IP)
//   3. the first non-internal IPv4 network interface (works on VPS/bare metal
//      where a public IP is bound directly)
// The result is cached in-process and refreshed daily.

const ECHO_SERVICES = [
  "https://api.ipify.org",
  "https://ipv4.icanhazip.com",
  "https://checkip.amazonaws.com",
];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

let cache: { ip: string; at: number } | null = null;

function fromInterfaces(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

async function fromEcho(): Promise<string | null> {
  for (const url of ECHO_SERVICES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const value = (await response.text()).trim();
      if (IPV4.test(value)) return value;
    } catch {
      // try the next service
    }
  }
  return null;
}

/**
 * Resolve the server's public IPv4 address. `fallback` (e.g. the request host)
 * is used only if every detection method fails.
 */
export async function getServerPublicIp(fallback?: string): Promise<string> {
  const override = process.env.SERVER_PUBLIC_IP?.trim();
  if (override) return override;

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ip;

  const detected = (await fromEcho()) ?? fromInterfaces();
  if (detected) {
    cache = { ip: detected, at: Date.now() };
    return detected;
  }
  return fallback?.trim() || "";
}
