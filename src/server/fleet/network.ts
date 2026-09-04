import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { AppError } from "@/server/cloudpanel/errors";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function publicIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false;
  const [a, b, c] = octets;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
    return false;
  return true;
}

function publicIpv6(address: string) {
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return false;
  if (value.startsWith("::ffff:")) return publicIpv4(value.slice(7));
  return !(
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:")
  );
}

export function isPublicFleetAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? publicIpv4(address)
    : family === 6
      ? publicIpv6(address)
      : false;
}

export function parseFleetOrigin(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError(
      "INVALID_REQUEST",
      "Enter a valid public Panelavo HTTPS address.",
      400,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.includes(".") ||
    isIP(url.hostname) !== 0
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Fleet panels must use a public HTTPS address on port 443.",
      400,
    );
  return `https://${url.hostname.toLowerCase()}`;
}

export async function resolveFleetOrigin(origin: string) {
  const url = new URL(parseFleetOrigin(origin));
  if (isIP(url.hostname))
    throw new AppError(
      "INVALID_REQUEST",
      "Fleet panels must use a DNS hostname with a valid TLS certificate.",
      400,
    );
  const [ipv4, ipv6] = await Promise.all([
    resolve4(url.hostname).catch(() => []),
    resolve6(url.hostname).catch(() => []),
  ]);
  const addresses = [
    ...ipv4.map((address) => ({ address, family: 4 as const })),
    ...ipv6.map((address) => ({ address, family: 6 as const })),
  ];
  if (
    !addresses.length ||
    addresses.some((entry) => !isPublicFleetAddress(entry.address))
  )
    throw new AppError(
      "FORBIDDEN",
      "The Fleet panel address does not resolve exclusively to public internet addresses.",
      403,
    );
  return { url, addresses };
}

export async function postFleetJson<T>(
  origin: string,
  path: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<T> {
  if (!/^\/api\/federation\/v1\/[a-z-]+$/.test(path))
    throw new AppError(
      "INVALID_REQUEST",
      "The federation endpoint is invalid.",
      400,
    );
  const { url, addresses } = await resolveFleetOrigin(origin);
  const selected = addresses[Math.floor(Math.random() * addresses.length)];
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length > 8 * 1024 * 1024)
    throw new AppError(
      "INVALID_REQUEST",
      "The federation request is too large.",
      413,
    );
  return new Promise<T>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path,
        method: "POST",
        servername: url.hostname,
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "user-agent": "Panelavo-Fleet/1",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(
              new Error("The federation response was too large."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new AppError(
                "REMOTE_ERROR",
                `The remote panel rejected the request (${response.statusCode ?? "unknown"}).`,
                502,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(
              new AppError(
                "REMOTE_ERROR",
                "The remote panel returned an invalid response.",
                502,
              ),
            );
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("The remote panel timed out.")),
    );
    request.on("error", (error) =>
      reject(
        new AppError(
          "REMOTE_ERROR",
          error.message || "The remote panel could not be reached.",
          502,
        ),
      ),
    );
    request.end(payload);
  });
}
