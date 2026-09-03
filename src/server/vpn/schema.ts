import { isIP } from "node:net";
import { z } from "zod";

const privateIpv4Cidr = z
  .string()
  .trim()
  .refine((value) => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(value);
    if (!match) return false;
    const octets = match.slice(1).map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return false;
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }, "Use a private RFC1918 /24 network ending in .0/24.");

const endpoint = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      isIP(value) === 4 ||
      /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(
        value,
      ),
    "Use a public IPv4 address or fully qualified hostname.",
  );

function isPublicDnsAddress(value: string) {
  const family = isIP(value);
  if (family === 4) {
    const [first, second, third] = value.split(".").map(Number);
    return !(
      first === 0 ||
      first === 10 ||
      (first === 100 && second >= 64 && second <= 127) ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (family !== 6) return false;
  const lower = value.toLowerCase();
  return !(
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff")
  );
}

const dnsAddress = z.string().trim().refine(isPublicDnsAddress, {
  message: "DNS entries must be public IPv4 or IPv6 resolver addresses.",
});

const deviceId = z.string().regex(/^[a-f0-9]{16}$/);
const deviceName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);

export const vpnManageSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("install"),
      endpoint,
      listenPort: z.number().int().min(1024).max(65535),
      ipv4Cidr: privateIpv4Cidr,
      dns: z
        .array(dnsAddress)
        .min(1)
        .max(4)
        .refine(
          (addresses) => addresses.some((address) => isIP(address) === 4),
          {
            message: "Include at least one public IPv4 DNS resolver.",
          },
        ),
      confirmation: z.literal("INSTALL VPN"),
    })
    .strict(),
  z.object({ action: z.literal("start") }).strict(),
  z
    .object({
      action: z.literal("stop"),
      confirmation: z.literal("STOP VPN"),
    })
    .strict(),
  z
    .object({
      action: z.literal("restart"),
      confirmation: z.literal("RESTART VPN"),
    })
    .strict(),
  z
    .object({
      action: z.literal("uninstall"),
      confirmation: z.literal("UNINSTALL VPN"),
    })
    .strict(),
  z.object({ action: z.literal("create-device"), name: deviceName }).strict(),
  z
    .object({ action: z.literal("rename-device"), deviceId, name: deviceName })
    .strict(),
  z
    .object({
      action: z.literal("rotate-device"),
      deviceId,
      confirmation: z.literal("ROTATE DEVICE"),
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke-device"),
      deviceId,
      confirmation: z.literal("REVOKE DEVICE"),
    })
    .strict(),
]);
