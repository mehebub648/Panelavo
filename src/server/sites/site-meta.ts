import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@/server/cloudpanel/errors";

// Panel-managed site metadata that CloudPanel has no concept of: the reserved
// site id (which doubles as the application port), the project category the id
// was allocated from, customer-facing alias domains, and how the system
// subdomain (site-<id>.<ip>.<base>) should behave once an alias is live.
// Mirrors the panel-roles / site-types overlays.

export type SiteCategory = {
  id: string;
  label: string;
  start: number;
  end: number;
};

export const SITE_CATEGORIES: SiteCategory[] = [
  { id: "client", label: "Client projects", start: 20000, end: 20999 },
  { id: "personal", label: "Personal projects", start: 21000, end: 21999 },
  { id: "business", label: "Business/SaaS projects", start: 22000, end: 22999 },
  { id: "friends", label: "Relatives/Friends projects", start: 23000, end: 23999 },
  { id: "demo", label: "Demo/Preview projects", start: 24000, end: 24999 },
  { id: "internal", label: "Internal tools", start: 25000, end: 25999 },
  { id: "reserved", label: "Reserved/Future", start: 26000, end: 29999 },
];

export type SubdomainBlockMode = "none" | "error" | "redirect";

export type SiteMeta = {
  id: number;
  category: string;
  aliases: string[];
  block: SubdomainBlockMode;
  redirectTo?: string;
};

type Store = { sites: Record<string, SiteMeta> };

const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "site-meta.json");

async function load(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), "utf8")) as Partial<Store>;
    return { sites: parsed.sites && typeof parsed.sites === "object" ? parsed.sites : {} };
  } catch {
    return { sites: {} };
  }
}

async function save(store: Store) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export function categoryById(id: string) {
  return SITE_CATEGORIES.find((category) => category.id === id);
}

export function siteUserForId(id: number) {
  return `site-${id}`;
}

export function systemDomainFor(id: number, serverIp: string, baseDomain: string) {
  return `site-${id}.${serverIp}.${baseDomain}`.toLowerCase();
}

export async function getAllSiteMeta() {
  return (await load()).sites;
}

export async function getSiteMeta(domain: string): Promise<SiteMeta | null> {
  return (await load()).sites[domain.toLowerCase()] ?? null;
}

export async function setSiteMeta(domain: string, meta: SiteMeta) {
  const store = await load();
  store.sites[domain.toLowerCase()] = meta;
  await save(store);
}

export async function removeSiteMeta(domain: string) {
  const store = await load();
  if (!(domain.toLowerCase() in store.sites)) return;
  delete store.sites[domain.toLowerCase()];
  await save(store);
}

/**
 * Next free id in a category. Ids reserved in the meta store and any ports the
 * caller already knows to be taken (e.g. appPorts of existing CloudPanel
 * sites) are skipped.
 */
export function nextFreeId(
  category: SiteCategory,
  reserved: Iterable<number>,
): number | null {
  const taken = new Set(reserved);
  for (let id = category.start; id <= category.end; id++) {
    if (!taken.has(id)) return id;
  }
  return null;
}

/**
 * Allocate the next id for a category, considering the meta store plus any
 * externally used ports. Throws when the category range is exhausted.
 */
export async function allocateSiteId(
  categoryId: string,
  externallyUsedPorts: number[] = [],
): Promise<{ id: number; category: SiteCategory }> {
  const category = categoryById(categoryId);
  if (!category)
    throw new AppError("INVALID_REQUEST", "Unknown project category.", 400);
  const store = await load();
  const reserved = [
    ...Object.values(store.sites).map((meta) => meta.id),
    ...externallyUsedPorts,
  ];
  const id = nextFreeId(category, reserved);
  if (id === null)
    throw new AppError(
      "INVALID_REQUEST",
      `No free ids are left in the ${category.label} range (${category.start}–${category.end}).`,
      409,
    );
  return { id, category };
}

/**
 * Move a site's reservation to a new id/port (site settings port change). The
 * new id must be inside one of the category ranges and not taken.
 */
export async function changeSiteId(
  domain: string,
  newId: number,
  externallyUsedPorts: number[] = [],
) {
  const store = await load();
  const key = domain.toLowerCase();
  const meta = store.sites[key];
  if (!meta) throw new AppError("SITE_NOT_FOUND", "This website has no reserved id.", 404);
  if (meta.id === newId) return meta;
  const category = SITE_CATEGORIES.find(
    (item) => newId >= item.start && newId <= item.end,
  );
  if (!category)
    throw new AppError(
      "INVALID_REQUEST",
      "Choose a port inside one of the project category ranges (20000–29999).",
      400,
    );
  const taken = new Set([
    ...Object.entries(store.sites)
      .filter(([other]) => other !== key)
      .map(([, value]) => value.id),
    ...externallyUsedPorts,
  ]);
  if (taken.has(newId))
    throw new AppError("INVALID_REQUEST", `Port ${newId} is already reserved by another website.`, 409);
  meta.id = newId;
  meta.category = category.id;
  await save(store);
  return meta;
}
