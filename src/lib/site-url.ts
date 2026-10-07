export function managedApplicationPort(siteId: number | null | undefined) {
  return Number.isInteger(siteId) &&
    Number(siteId) >= 20_000 &&
    Number(siteId) <= 29_999
    ? Number(siteId)
    : null;
}

export function managedSiteIdForApplicationPort(port: number) {
  return port >= 20_000 && port <= 29_999 ? port : null;
}

export function managedSiteIdsForExistingApplicationPort(port: number) {
  const ids: number[] = [];
  const current = managedSiteIdForApplicationPort(port);
  if (current !== null) ids.push(current);
  if (port >= 30_000 && port <= 39_999) ids.push(port - 10_000);
  return ids;
}

export function localSiteProxyUrl(siteId: number | null | undefined) {
  const port = managedApplicationPort(siteId);
  return port !== null ? `http://127.0.0.1:${port}` : "";
}

export function createdSiteRedirectUrl(
  base: string,
  created: { domain: string; type?: string; port?: number },
) {
  const url = new URL(base, "http://panelavo.local");
  url.searchParams.set("created", created.domain);
  if (created.type) url.searchParams.set("createdType", created.type);
  if (
    Number.isInteger(created.port) &&
    Number(created.port) >= 1 &&
    Number(created.port) <= 65_535
  )
    url.searchParams.set("createdPort", String(created.port));
  return `${url.pathname}${url.search}${url.hash}`;
}
