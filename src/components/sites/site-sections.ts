// Linked-service sites are proxy-only: they keep the domain/TLS/vhost/security
// surfaces and hide everything that assumes an app of their own. Shared by the
// section nav (tab visibility) and the section page (server-side guard).
export const SERVICE_SECTIONS: ReadonlySet<string> = new Set([
  "settings",
  "domains",
  "certificates",
  "vhost",
  "security",
  "users",
]);
