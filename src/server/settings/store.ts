import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
export const DEFAULT_UPDATE_REPOSITORY = "https://github.com/mehebub648/Panelavo.git";

type StoredSettings = {
  baseDomain?: string;
  updateRepository?: string;
};

export type PanelSettings = {
  baseDomain: string;
  updateRepository: string;
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
  const stored = await load();
  stored.baseDomain = baseDomain.trim().toLowerCase();
  await save(stored);
}

export async function setUpdateRepository(updateRepository: string) {
  const stored = await load();
  stored.updateRepository = updateRepository.trim();
  await save(stored);
}
