export const MANAGED_APPLICATION_PORT_OFFSET = 10_000;

export function managedApplicationPort(siteId: number | null | undefined) {
  return Number.isInteger(siteId) &&
    Number(siteId) >= 20_000 &&
    Number(siteId) <= 29_999
    ? Number(siteId) + MANAGED_APPLICATION_PORT_OFFSET
    : null;
}

export function managedSiteIdForApplicationPort(port: number) {
  const siteId = port - MANAGED_APPLICATION_PORT_OFFSET;
  return siteId >= 20_000 && siteId <= 29_999 ? siteId : null;
}

export function localSiteProxyUrl(siteId: number | null | undefined) {
  const port = managedApplicationPort(siteId);
  return port !== null ? `http://127.0.0.1:${port}` : "";
}
