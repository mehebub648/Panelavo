import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SiteType } from "@/types/cloudpanel";

// CloudPanel has no "docker" site type: docker sites are created as reverse
// proxies to the published container port, and this overlay remembers which
// domains are really docker sites so the panel can present them correctly.
// Mirrors the panel-roles overlay (src/server/auth/panel-roles.ts).
const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "site-types.json");

type Store = { types: Record<string, SiteType> };

export function isSiteActionAllowed(type: SiteType | undefined, command: string) {
  return type !== "docker" || command.startsWith("compose-");
}

async function load(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), "utf8")) as Partial<Store>;
    return { types: parsed.types && typeof parsed.types === "object" ? parsed.types : {} };
  } catch {
    return { types: {} };
  }
}

async function save(store: Store) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export async function getSiteTypeOverrides() {
  return (await load()).types;
}

export async function setSiteTypeOverride(domain: string, type: SiteType) {
  const store = await load();
  store.types[domain.toLowerCase()] = type;
  await save(store);
}

export async function removeSiteTypeOverride(domain: string) {
  const store = await load();
  if (!(domain.toLowerCase() in store.types)) return;
  delete store.types[domain.toLowerCase()];
  await save(store);
}
