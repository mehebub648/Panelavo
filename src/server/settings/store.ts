import { jsonStore } from "@/server/storage/json-store";

// Panel-wide settings. Environment values seed fresh/manual deployments;
// persisted values remain authoritative after an operator changes them.

type StoredSettings = {
  baseDomain?: string;
  updateRepository?: string;
  wildcardRegistrationEndpoint?: string;
  wildcardRegistrationBaseDomain?: string;
};

export type PanelSettings = {
  baseDomain: string;
  updateRepository: string;
  wildcardRegistrationEndpoint: string;
  wildcardRegistrationBaseDomain: string;
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
      "",
    updateRepository:
      stored.updateRepository ||
      process.env.PANEL_UPDATE_REPOSITORY?.trim() ||
      "",
    wildcardRegistrationEndpoint:
      stored.wildcardRegistrationEndpoint ||
      process.env.PANEL_WILDCARD_REGISTRATION_ENDPOINT?.trim() ||
      "",
    wildcardRegistrationBaseDomain:
      stored.wildcardRegistrationBaseDomain ||
      process.env.PANEL_WILDCARD_REGISTRATION_BASE_DOMAIN?.trim().toLowerCase() ||
      "",
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
