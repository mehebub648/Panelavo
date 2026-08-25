import { AppError } from "@/server/cloudpanel/errors";
import { jsonStore } from "@/server/storage/json-store";

// Panel-managed site metadata that CloudPanel has no concept of: the reserved
// site id, the project category the id
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
  {
    id: "friends",
    label: "Relatives/Friends projects",
    start: 23000,
    end: 23999,
  },
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
  // Linked-service sites: real CloudPanel reverse-proxy sites that the panel
  // groups under a parent site (e.g. api.app.com under app.com). `parent` is
  // the parent's lowercase system domain, `serviceName` the operator label.
  parent?: string;
  serviceName?: string;
  // Pending project endpoints reserve their derived identity and target port
  // without creating a CloudPanel site or a public reverse proxy.
  targetPort?: number;
  pending?: boolean;
};

type Store = { sites: Record<string, SiteMeta> };

const store = jsonStore<Store>(
  "site-meta.json",
  () => ({ sites: {} }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      sites:
        parsed?.sites && typeof parsed.sites === "object" ? parsed.sites : {},
    };
  },
);

export function categoryById(id: string) {
  return SITE_CATEGORIES.find((category) => category.id === id);
}

export function siteUserForId(id: number) {
  return `site-${id}`;
}

export function systemDomainFor(
  id: number,
  serverIp: string,
  baseDomain: string,
) {
  return `site-${id}.${serverIp}.${baseDomain}`.toLowerCase();
}

export async function getAllSiteMeta() {
  return (await store.load()).sites;
}

export async function getSiteMeta(domain: string): Promise<SiteMeta | null> {
  return (await store.load()).sites[domain.toLowerCase()] ?? null;
}

/** Project endpoints of a parent site, keyed by lowercase system domain. */
export async function getLinkedServiceMeta(
  parentDomain: string,
): Promise<Record<string, SiteMeta>> {
  const parent = parentDomain.toLowerCase();
  return Object.fromEntries(
    Object.entries((await store.load()).sites).filter(
      ([, meta]) => meta.parent === parent,
    ),
  );
}

export async function setSiteMeta(domain: string, meta: SiteMeta) {
  const value = await store.load();
  value.sites[domain.toLowerCase()] = meta;
  await store.save(value);
}

export async function removeSiteMeta(domain: string) {
  const value = await store.load();
  if (!(domain.toLowerCase() in value.sites)) return;
  delete value.sites[domain.toLowerCase()];
  await store.save(value);
}

/**
 * Next free id in a category. Ids reserved in the meta store and any additional
 * ids whose derived application ports are unavailable are skipped.
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
 * additional unavailable ids. Throws when the category range is exhausted.
 */
export async function allocateSiteId(
  categoryId: string,
  externallyUsedPorts: number[] = [],
): Promise<{ id: number; category: SiteCategory }> {
  const category = categoryById(categoryId);
  if (!category)
    throw new AppError("INVALID_REQUEST", "Unknown project category.", 400);
  const value = await store.load();
  const reserved = [
    ...Object.values(value.sites).map((meta) => meta.id),
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
 * Move a site's identity reservation to another category id. Runtime port
 * changes do not call this helper and never change site identity.
 */
export async function changeSiteId(
  domain: string,
  newId: number,
  externallyUsedPorts: number[] = [],
) {
  const value = await store.load();
  const key = domain.toLowerCase();
  const meta = validateSiteIdChange(
    value.sites,
    key,
    newId,
    externallyUsedPorts,
  );
  if (meta.id === newId) return meta;
  const category = SITE_CATEGORIES.find(
    (item) => newId >= item.start && newId <= item.end,
  )!;
  meta.id = newId;
  meta.category = category.id;
  await store.save(value);
  return meta;
}

export function validateSiteIdChange(
  sites: Record<string, SiteMeta>,
  domain: string,
  newId: number,
  externallyUsedPorts: number[] = [],
) {
  const key = domain.toLowerCase();
  const meta = sites[key];
  if (!meta)
    throw new AppError(
      "SITE_NOT_FOUND",
      "This website has no reserved id.",
      404,
    );
  if (meta.id === newId) return meta;
  const category = SITE_CATEGORIES.find(
    (item) => newId >= item.start && newId <= item.end,
  );
  if (!category)
    throw new AppError(
      "INVALID_REQUEST",
      "Choose a site id inside one of the project category ranges (20000–29999).",
      400,
    );
  const taken = new Set([
    ...Object.entries(sites)
      .filter(([other]) => other !== key)
      .map(([, value]) => value.id),
    ...externallyUsedPorts,
  ]);
  if (taken.has(newId))
    throw new AppError(
      "INVALID_REQUEST",
      `Site id ${newId} is already reserved by another website.`,
      409,
    );
  return meta;
}

export async function assertSiteIdChange(
  domain: string,
  newId: number,
  externallyUsedPorts: number[] = [],
) {
  return validateSiteIdChange(
    (await store.load()).sites,
    domain,
    newId,
    externallyUsedPorts,
  );
}
