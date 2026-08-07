import { jsonStore } from "@/server/storage/json-store";
import type { SiteType } from "@/types/cloudpanel";

// CloudPanel has no "docker" site type: docker sites are created as reverse
// proxies to the published container port, and this overlay remembers which
// domains are really docker sites so the panel can present them correctly.
// Mirrors the panel-roles overlay (src/server/auth/panel-roles.ts).
type Store = { types: Record<string, SiteType> };

export function isSiteActionAllowed(
  type: SiteType | undefined,
  command: string,
) {
  return (
    type !== "docker" ||
    command.startsWith("compose-") ||
    [
      "prepare-rootless-migration",
      "cutover-rootless-migration",
      "recover-rootless-migration",
    ].includes(command)
  );
}

const store = jsonStore<Store>(
  "site-types.json",
  () => ({ types: {} }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      types:
        parsed?.types && typeof parsed.types === "object" ? parsed.types : {},
    };
  },
);

export async function getSiteTypeOverrides() {
  return (await store.load()).types;
}

export async function setSiteTypeOverride(domain: string, type: SiteType) {
  const value = await store.load();
  value.types[domain.toLowerCase()] = type;
  await store.save(value);
}

export async function removeSiteTypeOverride(domain: string) {
  const value = await store.load();
  if (!(domain.toLowerCase() in value.types)) return;
  delete value.types[domain.toLowerCase()];
  await store.save(value);
}
