import { jsonStore } from "@/server/storage/json-store";

// CloudPanel stores the directory served by NGINX, but a PHP or static
// project can keep its repository one or more levels above that document
// root. This overlay remembers Panelavo's workspace root for each site.
type Store = { roots: Record<string, string> };
const store = jsonStore<Store>(
  "site-roots.json",
  () => ({ roots: {} }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      roots:
        parsed?.roots && typeof parsed.roots === "object" ? parsed.roots : {},
    };
  },
);

export async function getSiteRootOverride(domain: string) {
  return (await store.load()).roots[domain.toLowerCase()];
}

export async function setSiteRootOverride(domain: string, root: string) {
  const value = await store.load();
  value.roots[domain.toLowerCase()] = root;
  await store.save(value);
}

export async function removeSiteRootOverride(domain: string) {
  const value = await store.load();
  const key = domain.toLowerCase();
  if (!(key in value.roots)) return;
  delete value.roots[key];
  await store.save(value);
}
