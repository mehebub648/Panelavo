import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@/server/cloudpanel/errors";
import { cf, type CloudflareRecord } from "@/server/cloudflare/store";

// Panel-wide settings: the base domain that system subdomains
// (site-<id>.<ip>.<baseDomain>) are created under, and an optional Cloudflare
// API token with DNS access to that domain so new sites are pointed at this
// server automatically. Seeded from PANEL_BASE_DOMAIN at first run and
// editable on the Settings page. The Cloudflare token is stored encrypted.

type StoredSettings = {
  baseDomain?: string;
  cloudflare?: { token: { iv: string; tag: string; data: string }; updatedAt: string };
};

export type PanelSettings = {
  baseDomain: string;
  cloudflare: { configured: boolean; updatedAt?: string };
};

const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "panel-settings.json");

type ZoneCache = { zones: { id: string; name: string }[]; expiresAt: number };
let zoneCache: ZoneCache | null = null;

function key() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError("INTERNAL_ERROR", "Credential encryption is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(payload: { iv: string; tag: string; data: string }) {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

async function load(): Promise<StoredSettings> {
  try {
    return JSON.parse(await readFile(storeFile(), "utf8")) as StoredSettings;
  } catch {
    return {};
  }
}

async function save(settings: StoredSettings) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export async function getPanelSettings(): Promise<PanelSettings> {
  const stored = await load();
  return {
    baseDomain: stored.baseDomain || process.env.PANEL_BASE_DOMAIN?.trim().toLowerCase() || "",
    cloudflare: { configured: Boolean(stored.cloudflare), updatedAt: stored.cloudflare?.updatedAt },
  };
}

export async function getBaseDomain(): Promise<string> {
  return (await getPanelSettings()).baseDomain;
}

export async function setBaseDomain(baseDomain: string) {
  const stored = await load();
  stored.baseDomain = baseDomain.trim().toLowerCase();
  await save(stored);
}

export async function setPanelCloudflareToken(token: string) {
  await cf(token, "/zones?per_page=1");
  const stored = await load();
  stored.cloudflare = { token: encrypt(token.trim()), updatedAt: new Date().toISOString() };
  await save(stored);
  zoneCache = null;
}

export async function clearPanelCloudflareToken() {
  const stored = await load();
  delete stored.cloudflare;
  await save(stored);
  zoneCache = null;
}

async function panelToken(): Promise<string | null> {
  const stored = await load();
  if (!stored.cloudflare) return null;
  try {
    return decrypt(stored.cloudflare.token);
  } catch {
    return null;
  }
}

async function panelZones() {
  if (zoneCache && zoneCache.expiresAt > Date.now()) return zoneCache.zones;
  const token = await panelToken();
  if (!token) return [];
  const zones: { id: string; name: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await cf<{ id: string; name: string }[]>(
      token,
      `/zones?per_page=50&page=${page}&status=active`,
    );
    zones.push(...batch);
    if (batch.length < 50) break;
  }
  zoneCache = { zones, expiresAt: Date.now() + 10 * 60_000 };
  return zones;
}

/** Zone managed by the panel token that covers `hostname`, if any. */
export async function panelZoneFor(hostname: string) {
  const host = hostname.toLowerCase();
  try {
    const zones = await panelZones();
    return (
      zones
        .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Create/replace an A record for `name` using the panel-wide token. Returns
 * null when no token is configured or no zone covers the name.
 */
export async function setPanelARecord(input: {
  name: string;
  ip: string;
  replace?: boolean;
  proxied?: boolean;
}): Promise<CloudflareRecord | null> {
  const token = await panelToken();
  if (!token) return null;
  const zone = await panelZoneFor(input.name);
  if (!zone) return null;
  const existing = (
    await cf<CloudflareRecord[]>(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records?type=A&name=${encodeURIComponent(input.name)}`,
    )
  )[0];
  if (existing && !input.replace && existing.content !== input.ip)
    throw new AppError(
      "DOMAIN_ALREADY_EXISTS",
      `An A record for ${input.name} already points to ${existing.content}.`,
      409,
    );
  const body = JSON.stringify({
    type: "A",
    name: input.name,
    content: input.ip,
    ttl: 1,
    proxied: input.proxied ?? false,
  });
  return existing
    ? cf<CloudflareRecord>(token, `/zones/${zone.id}/dns_records/${existing.id}`, { method: "PUT", body })
    : cf<CloudflareRecord>(token, `/zones/${zone.id}/dns_records`, { method: "POST", body });
}

/** Delete the A record for `name` if the panel token manages its zone. */
export async function deletePanelARecord(name: string) {
  const token = await panelToken();
  if (!token) return;
  const zone = await panelZoneFor(name);
  if (!zone) return;
  const existing = (
    await cf<CloudflareRecord[]>(
      token,
      `/zones/${encodeURIComponent(zone.id)}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    )
  )[0];
  if (existing) await cf(token, `/zones/${zone.id}/dns_records/${existing.id}`, { method: "DELETE" });
}
