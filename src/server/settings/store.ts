import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Panel-wide settings: the base domain that system subdomains
// (site-<id>.<ip>.<baseDomain>) are created under. The DNS requirement is a
// single wildcard record: *.<server-ip>.<baseDomain> -> this server.
// Seeded from PANEL_BASE_DOMAIN at first run and editable on the Settings page.

type StoredSettings = {
  baseDomain?: string;
};

export type PanelSettings = {
  baseDomain: string;
};

const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "panel-settings.json");

async function load(): Promise<StoredSettings> {
  try {
    return JSON.parse(await readFile(storeFile(), "utf8")) as StoredSettings;
  } catch {
    return {};
  }
}

async function save(settings: StoredSettings) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export async function getPanelSettings(): Promise<PanelSettings> {
  const stored = await load();
  return {
    baseDomain: stored.baseDomain || process.env.PANEL_BASE_DOMAIN?.trim().toLowerCase() || "",
  };
}

export async function getBaseDomain(): Promise<string> {
  return (await getPanelSettings()).baseDomain;
}

export async function setBaseDomain(baseDomain: string) {
  const stored = await load();
  stored.baseDomain = baseDomain.trim().toLowerCase();
  await save(stored);
}
