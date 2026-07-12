export function localSiteProxyUrl(siteId: number | null | undefined) {
  return Number.isInteger(siteId) && Number(siteId) > 0
    ? `http://127.0.0.1:${siteId}`
    : "";
}
