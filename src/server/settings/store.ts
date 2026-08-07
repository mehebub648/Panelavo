import { jsonStore } from "@/server/storage/json-store";

// Panel-wide settings: the base domain that system subdomains
// (site-<id>.<ip>.<baseDomain>) are created under. The DNS requirement is a
// single wildcard record: *.<server-ip>.<baseDomain> -> this server.
// Seeded from PANEL_BASE_DOMAIN at first run and editable on the Settings page.
// When the operator has no domain of their own we fall back to mehebub.com,
// whose wildcard can be self-registered automatically via ippointer.

// Default base domain used when nothing is configured. Its wildcard zone is
// managed by ippointer (see server/network/ippointer.ts), so a fresh install
// can register *.<ip>.mehebub.com without the operator owning a domain.
export const DEFAULT_BASE_DOMAIN = "mehebub.com";
export const DEFAULT_UPDATE_REPOSITORY =
  "https://github.com/mehebub648/Panelavo.git";

type StoredSettings = {
  baseDomain?: string;
  updateRepository?: string;
};

export type PanelSettings = {
  baseDomain: string;
  updateRepository: string;
};

const store = jsonStore<StoredSettings>(
  "panel-settings.json",
  () => ({}),
  (value) =>
    value && typeof value === "object" ? (value as StoredSettings) : {},
);

export async function getPanelSettings(): Promise<PanelSettings> {
  const stored = await store.load();
  return {
    baseDomain:
      stored.baseDomain ||
      process.env.PANEL_BASE_DOMAIN?.trim().toLowerCase() ||
      DEFAULT_BASE_DOMAIN,
    updateRepository:
      stored.updateRepository ||
      process.env.PANEL_UPDATE_REPOSITORY?.trim() ||
      DEFAULT_UPDATE_REPOSITORY,
  };
}

export async function getBaseDomain(): Promise<string> {
  return (await getPanelSettings()).baseDomain;
}

export async function setBaseDomain(baseDomain: string) {
  const stored = await store.load();
  stored.baseDomain = baseDomain.trim().toLowerCase();
  await store.save(stored);
}

export async function setUpdateRepository(updateRepository: string) {
  const stored = await store.load();
  stored.updateRepository = updateRepository.trim();
  await store.save(stored);
}
