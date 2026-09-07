export const fleetSections = [
  "overview",
  "websites",
  "domains",
  "ai-access",
  "resources",
  "information",
  "vpn",
  "about",
  "users",
  "audit",
  "settings",
  "updates",
] as const;
export type FleetSection = (typeof fleetSections)[number];

export function fleetSection(value: string | null | undefined): FleetSection {
  return fleetSections.includes(value as FleetSection)
    ? (value as FleetSection)
    : "websites";
}

export function selectedFleetServer(pathname: string): string {
  return pathname.match(/^\/servers\/([^/]+)(?:\/|$)/)?.[1] ?? "local";
}

export function fleetSectionHref(
  serverId: string,
  section: FleetSection,
): string {
  return `/servers/${encodeURIComponent(serverId)}?tab=${section}`;
}

// A website on one server is not necessarily the same website on another.
export function switchFleetServer(
  serverId: string,
  pathname: string,
  tab?: string | null,
): string {
  const creating = pathname.endsWith("/sites/new");
  const section = pathname.includes("/sites")
    ? "websites"
    : pathname.startsWith("/servers/")
      ? fleetSection(tab)
      : fleetSection(pathname.slice(1));
  if (serverId === "local") {
    if (creating) return "/sites/new";
    if (section === "websites" || section === "overview") return "/sites";
    if (section === "updates") return "/settings";
    return `/${section}`;
  }
  return creating
    ? `/servers/${encodeURIComponent(serverId)}/sites/new`
    : fleetSectionHref(serverId, section);
}
