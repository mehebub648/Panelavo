import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// CloudPanel stores the directory served by NGINX, but a PHP or static
// project can keep its repository one or more levels above that document
// root. This overlay remembers Panelavo's workspace root for each site.
const dataDir = () =>
  process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "site-roots.json");

type Store = { roots: Record<string, string> };

async function load(): Promise<Store> {
  try {
    const parsed = JSON.parse(
      await readFile(storeFile(), "utf8"),
    ) as Partial<Store>;
    return {
      roots:
        parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {},
    };
  } catch {
    return { roots: {} };
  }
}

async function save(store: Store) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export async function getSiteRootOverride(domain: string) {
  return (await load()).roots[domain.toLowerCase()];
}

export async function setSiteRootOverride(domain: string, root: string) {
  const store = await load();
  store.roots[domain.toLowerCase()] = root;
  await save(store);
}

export async function removeSiteRootOverride(domain: string) {
  const store = await load();
  const key = domain.toLowerCase();
  if (!(key in store.roots)) return;
  delete store.roots[key];
  await save(store);
}
