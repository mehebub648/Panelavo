import { basename } from "node:path";
import { getPanelAddressState } from "@/server/settings/panel-address-store";

// The panel itself runs inside a CloudPanel site (setup.sh deploys it to
// /home/<site-user>/htdocs/<panel-domain>), so the basename of the working
// directory IS the panel's own domain. That site must never be listed or
// managed from the panel UI — deleting or editing it would take the panel
// down from under itself.
//
// Detection is dynamic (no hardcoded domain): cwd basename, overridable with
// PANEL_SELF_DOMAIN. A basename without a dot (e.g. a dev checkout like
// ~/code/panelavo) is not a domain, so nothing is hidden in that case.

export function getPanelSelfDomain(): string | null {
  const configured = process.env.PANEL_SELF_DOMAIN?.trim().toLowerCase();
  if (configured) return configured;
  const dir = basename(process.cwd()).toLowerCase();
  return dir.includes(".") ? dir : null;
}

export function isPanelSelfDomain(domain: string): boolean {
  return getPanelKnownDomains().includes(domain.trim().toLowerCase());
}

export function getPanelPublicDomain(): string | null {
  const origin = getPanelAddressState().origin;
  return origin ? new URL(origin).hostname : getPanelSelfDomain();
}

export function getPanelKnownDomains(): string[] {
  const state = getPanelAddressState();
  return [
    ...new Set(
      [
        getPanelSelfDomain(),
        ...[state.origin, state.pending?.origin, ...state.previousOrigins]
          .filter((origin): origin is string => Boolean(origin))
          .map((origin) => new URL(origin).hostname),
      ].filter((domain): domain is string => Boolean(domain)),
    ),
  ];
}
