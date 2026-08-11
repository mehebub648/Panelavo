import { jsonStore } from "@/server/storage/json-store";
import type { CloudPanelSite } from "@/types/cloudpanel";

export type SiteLabelRecord = { label: string; siteId: string };
type Store = { labels: Record<string, SiteLabelRecord> };

const store = jsonStore<Store>(
  "site-labels.json",
  () => ({ labels: {} }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      labels:
        parsed?.labels && typeof parsed.labels === "object"
          ? parsed.labels
          : {},
    };
  },
);

export async function getLabelsForSites(sites: CloudPanelSite[]) {
  const labels = (await store.load()).labels;
  return Object.fromEntries(
    sites.flatMap((site) => {
      const record = labels[site.domain.toLowerCase()];
      return record && record.siteId === site.id
        ? [[site.domain.toLowerCase(), record.label]]
        : [];
    }),
  );
}

export async function getSiteLabel(domain: string, siteId: string) {
  const record = (await store.load()).labels[domain.toLowerCase()];
  return record?.siteId === siteId ? record.label : undefined;
}

export async function setSiteLabel(
  domain: string,
  siteId: string,
  label: string,
) {
  const value = await store.load();
  const key = domain.toLowerCase();
  if (label) value.labels[key] = { label, siteId };
  else delete value.labels[key];
  await store.save(value);
}

export async function removeSiteLabel(domain: string) {
  const value = await store.load();
  const key = domain.toLowerCase();
  if (!(key in value.labels)) return;
  delete value.labels[key];
  await store.save(value);
}
