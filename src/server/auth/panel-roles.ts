import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";

// CloudPanel only stores admin / site-manager / user. The panel "admin" tier
// (creates sites, sees only assigned + own) is a CloudPanel "user" elevated by
// this local overlay, so CloudPanel itself keeps restricting their site list
// to assigned sites. Sites a panel admin creates are auto-assigned to them.
// PANEL_DATA_DIR is only set by tests, to keep them away from the live store.
const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const storeFile = () => join(dataDir(), "panel-roles.json");

type Store = { admins: string[] };

async function load(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), "utf8")) as Partial<Store>;
    return {
      admins: Array.isArray(parsed.admins)
        ? parsed.admins.map((name) => String(name).toLowerCase())
        : [],
    };
  } catch {
    return { admins: [] };
  }
}

async function save(store: Store) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await rename(tmp, storeFile());
}

export async function isPanelAdmin(username: string) {
  return (await load()).admins.includes(username.toLowerCase());
}

export async function setPanelAdmin(username: string, enabled: boolean) {
  const store = await load();
  const name = username.toLowerCase();
  const has = store.admins.includes(name);
  if (enabled === has) return;
  store.admins = enabled
    ? [...store.admins, name]
    : store.admins.filter((item) => item !== name);
  await save(store);
}

// CloudPanel role that backs each panel role (used when writing users).
export function cloudRoleFor(panelRole: PanelRole) {
  return panelRole === "super-admin"
    ? "admin"
    : panelRole === "manager"
      ? "site-manager"
      : "user";
}

export async function decorateUser(user: CloudPanelUser): Promise<CloudPanelUser> {
  if (user.role === "admin")
    return { ...user, panelRole: "super-admin", canCreateSites: true };
  if (user.role === "site-manager")
    return { ...user, panelRole: "manager", canCreateSites: true };
  const elevated = await isPanelAdmin(user.username);
  return { ...user, panelRole: elevated ? "admin" : "user", canCreateSites: elevated };
}
