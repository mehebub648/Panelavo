import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@/server/cloudpanel/errors";

export type CloudflareCredential = { id: string; label: string; token: string; createdAt: string };
export type CloudflareZone = { id: string; name: string; status: string; credentialId: string; credentialLabel: string };
export type CloudflareRecord = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number };
type Store = { users: Record<string, CloudflareCredential[]> };
type CacheEntry = { zones: CloudflareZone[]; expiresAt: number; refreshedAt: string };

const file = join(process.cwd(), ".data", "cloudflare-credentials.enc");
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<{ zones: CloudflareZone[]; refreshedAt: string; cached: boolean }>>();

function key() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new AppError("INTERNAL_ERROR", "Credential encryption is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}
async function load(): Promise<Store> {
  try {
    const payload = JSON.parse(await readFile(file, "utf8")) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8")) as Store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { users: {} };
    throw error;
  }
}
async function save(store: Store) {
  await mkdir(join(process.cwd(), ".data"), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(store)), cipher.final()]);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
  await rename(tmp, file);
}
async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers }, signal: AbortSignal.timeout(12_000) });
  const body = await response.json() as { success: boolean; result: T; errors?: { message: string }[] };
  if (!response.ok || !body.success) throw new AppError("INVALID_REQUEST", body.errors?.[0]?.message || "Cloudflare rejected the request.", response.status === 401 || response.status === 403 ? 403 : 502);
  return body.result;
}

export async function listCredentials(userId: string) {
  return (await load()).users[userId]?.map((item) => ({ id: item.id, label: item.label, createdAt: item.createdAt })) ?? [];
}
export async function addCredential(userId: string, label: string, token: string) {
  await cf(token, "/user/tokens/verify");
  const store = await load(); const item = { id: randomUUID(), label: label.trim(), token: token.trim(), createdAt: new Date().toISOString() };
  store.users[userId] = [...(store.users[userId] ?? []), item]; await save(store); cache.delete(userId);
  return { id: item.id, label: item.label, createdAt: item.createdAt };
}
export async function deleteCredential(userId: string, id: string) {
  const store = await load(); store.users[userId] = (store.users[userId] ?? []).filter((item) => item.id !== id); await save(store); cache.delete(userId);
}
async function credential(userId: string, id: string) {
  const item = (await load()).users[userId]?.find((entry) => entry.id === id);
  if (!item) throw new AppError("FORBIDDEN", "Cloudflare credential is not available to this user.", 403);
  return item;
}
export async function getZones(userId: string, refresh = false) {
  const cached = cache.get(userId); if (!refresh && cached && cached.expiresAt > Date.now()) return { zones: cached.zones, refreshedAt: cached.refreshedAt, cached: true };
  const running = inFlight.get(userId); if (running) return running;
  const job = refreshZones(userId); inFlight.set(userId, job);
  try { return await job; } finally { inFlight.delete(userId); }
}
async function refreshZones(userId: string) {
  const credentials = (await load()).users[userId] ?? [];
  const results = await Promise.allSettled(credentials.map(async (cred) => { const all: { id: string; name: string; status: string }[] = []; for (let page = 1; page <= 20; page++) { const batch = await cf<{ id: string; name: string; status: string }[]>(cred.token, `/zones?per_page=50&page=${page}&status=active`); all.push(...batch); if (batch.length < 50) break; } return all.map((zone) => ({ ...zone, credentialId: cred.id, credentialLabel: cred.label })); }));
  const zones = results.flatMap((result) => result.status === "fulfilled" ? result.value : []).sort((a, b) => a.name.localeCompare(b.name));
  const refreshedAt = new Date().toISOString(); cache.set(userId, { zones, refreshedAt, expiresAt: Date.now() + 10 * 60_000 }); return { zones, refreshedAt, cached: false };
}
export async function getRecords(userId: string, credentialId: string, zoneId: string) {
  const cred = await credential(userId, credentialId); const records: CloudflareRecord[] = [];
  for (let page = 1; page <= 50; page++) { const batch = await cf<CloudflareRecord[]>(cred.token, `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100&page=${page}`); records.push(...batch); if (batch.length < 100) break; }
  return records;
}
export async function checkARecord(userId: string, credentialId: string, zoneId: string, name: string) {
  const cred = await credential(userId, credentialId); const records = await cf<CloudflareRecord[]>(cred.token, `/zones/${encodeURIComponent(zoneId)}/dns_records?type=A&name=${encodeURIComponent(name)}`); return records[0] ?? null;
}
export async function setARecord(userId: string, input: { credentialId: string; zoneId: string; name: string; ip: string; replace?: boolean; proxied?: boolean }) {
  const cred = await credential(userId, input.credentialId); const existing = await checkARecord(userId, input.credentialId, input.zoneId, input.name);
  if (existing && !input.replace) throw new AppError("DOMAIN_ALREADY_EXISTS", `An A record already points to ${existing.content}. Choose Replace or change the domain.`, 409);
  const body = JSON.stringify({ type: "A", name: input.name, content: input.ip, ttl: 1, proxied: input.proxied ?? false });
  return existing ? cf<CloudflareRecord>(cred.token, `/zones/${input.zoneId}/dns_records/${existing.id}`, { method: "PUT", body }) : cf<CloudflareRecord>(cred.token, `/zones/${input.zoneId}/dns_records`, { method: "POST", body });
}
export async function mutateRecord(userId: string, credentialId: string, zoneId: string, input: { action: string; id?: string; record?: Partial<CloudflareRecord> }) {
  const cred = await credential(userId, credentialId);
  if (input.action === "delete" && input.id) return cf(cred.token, `/zones/${zoneId}/dns_records/${input.id}`, { method: "DELETE" });
  const body = JSON.stringify(input.record); const path = input.id ? `/zones/${zoneId}/dns_records/${input.id}` : `/zones/${zoneId}/dns_records`;
  return cf<CloudflareRecord>(cred.token, path, { method: input.id ? "PUT" : "POST", body });
}
