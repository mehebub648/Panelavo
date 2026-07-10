import { basename } from "node:path";

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
  const self = getPanelSelfDomain();
  return self !== null && domain.trim().toLowerCase() === self;
}
