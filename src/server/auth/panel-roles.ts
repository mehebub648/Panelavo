import { jsonStore } from "@/server/storage/json-store";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";

// CloudPanel only stores admin / site-manager / user. The panel "admin" tier
// (creates sites, sees only assigned + own) is a CloudPanel "user" elevated by
// this local overlay, so CloudPanel itself keeps restricting their site list
// to assigned sites. Sites a panel admin creates are auto-assigned to them.
// PANEL_DATA_DIR is only set by tests, to keep them away from the live store.
type Store = { admins: string[] };
const store = jsonStore<Store>(
  "panel-roles.json",
  () => ({ admins: [] }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      admins: Array.isArray(parsed?.admins)
        ? parsed.admins.map((name) => String(name).toLowerCase())
        : [],
    };
  },
);

export async function isPanelAdmin(username: string) {
  return (await store.load()).admins.includes(username.toLowerCase());
}

export async function setPanelAdmin(username: string, enabled: boolean) {
  const value = await store.load();
  const name = username.toLowerCase();
  const has = value.admins.includes(name);
  if (enabled === has) return;
  value.admins = enabled
    ? [...value.admins, name]
    : value.admins.filter((item) => item !== name);
  await store.save(value);
}

// CloudPanel role that backs each panel role (used when writing users).
export function cloudRoleFor(panelRole: PanelRole) {
  return panelRole === "super-admin"
    ? "admin"
    : panelRole === "manager"
      ? "site-manager"
      : "user";
}

export async function decorateUser(
  user: CloudPanelUser,
): Promise<CloudPanelUser> {
  if (user.role === "admin")
    return { ...user, panelRole: "super-admin", canCreateSites: true };
  if (user.role === "site-manager")
    return { ...user, panelRole: "manager", canCreateSites: true };
  const elevated = await isPanelAdmin(user.username);
  return {
    ...user,
    panelRole: elevated ? "admin" : "user",
    canCreateSites: elevated,
  };
}
