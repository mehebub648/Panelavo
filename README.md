# Server Panel

A small, modern Next.js frontend for an existing CloudPanel installation. CloudPanel remains the source of truth for accounts, passwords, MFA, roles, site assignments, runtime support, and server-side permissions. This application creates no user database and never sends a CloudPanel cookie to the browser.

## Stack

Next.js App Router, strict TypeScript, Tailwind CSS, shadcn-style local UI components, Lucide, Zod, pnpm, ESLint, Prettier, and Vitest.

## Quick start (mock mode)

```bash
cp .env.example .env.local
# Set SESSION_SECRET to: openssl rand -base64 32
npx pnpm@10.12.1 install
npx pnpm@10.12.1 dev
```

Open `http://localhost:3000`.

| Account   | Password     | Behavior                              |
| --------- | ------------ | ------------------------------------- |
| `admin`   | `admin123`   | Administrator; all sites and creation |
| `manager` | `manager123` | Site manager; all sites and creation  |
| `user`    | `user123`    | Restricted to one assigned site       |
| `empty`   | `empty123`   | Restricted user with no sites         |
| `mfa`     | `mfa123`     | Administrator with MFA; code `123456` |
| `offline` | any          | Simulated CloudPanel outage           |

Mock credentials are development-only. Never enable mock mode on a public production deployment.

## Environment

Copy `.env.example` to `.env.local`. Use `CLOUDPANEL_MODE=mock` for local UI work or `CLOUDPANEL_MODE=live` for the installed panel. `CLOUDPANEL_TLS_VERIFY=false` is an explicit development escape hatch for a self-signed local certificate; it weakens server identity verification. Production should use a trusted certificate or configured CA and leave verification enabled.

The application cookie is opaque, `HttpOnly`, `SameSite=Strict`, scoped to `/`, and `Secure` in production. Sessions expire after `SESSION_MAX_AGE_SECONDS`. The initial session store is process memory, so production must run a single Next.js process. Replace the isolated store in `src/server/auth/session.ts` before horizontal scaling or zero-downtime multi-process restarts.

## Tested CloudPanel integration

The live adapter was developed against the CloudPanel installation on this host on 2026-07-08:

- Frontend asset version: **2.5.4**
- CLI version: **6.0.8**
- Panel origin: configured by `CLOUDPANEL_BASE_URL` (locally observed on HTTPS port 8443)

Discovery was performed without modifying CloudPanel. `GET /` redirected to `/login`; `GET /login` returned a server-rendered form; and login used `POST /login` with `userName`, `password`, and a per-session `_csrf_token`. CloudPanel issued an `HttpOnly`, `Secure`, `SameSite=Lax` `cloudpanel` session cookie. Invalid login redirected to `/login` and displayed `Invalid credentials.`. The version came from the login asset query strings. CloudPanel’s original frontend remains untouched.

No real CloudPanel credentials were supplied during development. Consequently, the authenticated 2FA field names and authenticated site table markup could not be exercised end to end. The adapter discovers the MFA form fields and site-list link from authenticated HTML and fails closed with `CLOUDPANEL_VERSION_UNSUPPORTED` if the expected semantic markup is absent. These parsers are the explicitly undocumented, version-sensitive part of the integration and live only in `src/server/cloudpanel/live-client.ts`.

### Authentication and authorization

The server owns the CloudPanel cookie jar. After CloudPanel accepts credentials (and MFA, when requested), the browser receives only a random application-session identifier. Every protected route revalidates the CloudPanel session and current role. Restricted lists come from the authenticated CloudPanel page; the browser is never given an unrestricted list to filter.

The live HTML adapter conservatively identifies create permission from CloudPanel’s role/authorized creation navigation. Unknown roles do not receive elevated access. MFA form action, code field, CSRF value, and temporary CloudPanel cookies remain in the server session.

### Site list

The live adapter follows the authenticated landing page, discovers the authorized Sites navigation target, and parses the server-rendered table. This is undocumented CloudPanel behavior. If CloudPanel changes that markup, the adapter returns a compatibility error rather than guessing an endpoint or querying its database.

### Site creation

CloudPanel does not document a public REST API for site creation. Version 2.5.4’s documented `clpctl` operations are used through the installed root-owned `/usr/bin/clpctlWrapper`. The Node process calls `/usr/bin/sudo` with an argument array, `shell: false`, a fixed per-type operation map, validation, a 90-second timeout, bounded output, and generic errors. There is no generic command endpoint and no browser-supplied CLI operation.

The server account on this host has the existing narrow sudo permission:

```text
NOPASSWD: /usr/bin/clpctlWrapper
```

Do not grant `clpctl *`, `bash *`, `sh *`, or unrestricted sudo to a deployment user. For stronger production isolation, replace the current vendor wrapper permission with root-owned per-operation wrappers that accept only validated fields.

PHP versions are discovered from `/etc/php`. CloudPanel 2.5.4 compatibility fallbacks for Node.js, Python, and the Generic vhost template are isolated in the live adapter because no authenticated options page was available during discovery. Validate these against the target server before production use.

## Security assumptions and limitations

- State-changing API requests require JSON, same-origin fetch metadata, and a matching configured origin when supplied.
- Login, MFA, and site creation have in-process rate limits. Use a shared trusted rate limiter before multi-instance deployment.
- API responses are non-cacheable. Middleware sets CSP, anti-framing, MIME-sniffing, referrer, and permissions headers.
- Audit logs are structured and centrally redact passwords, MFA codes, cookies, CSRF values, and authorization data.
- Passwords are never persisted, echoed by APIs, or written to browser storage. A failed create clears the site password.
- TLS verification must remain enabled in production.
- The live authenticated parsers require a credentialed staging acceptance test before production. See the checklist below.

## Live acceptance checklist

1. Set `CLOUDPANEL_MODE=live`, the base URL, version `2.5.4`, and a strong session secret.
2. Confirm a trusted TLS chain, or explicitly accept the documented development-only risk.
3. Test an admin, site manager, restricted user, MFA user, and invalid password.
4. Confirm the restricted account sees exactly its assigned sites and cannot call `POST /api/sites`.
5. Create a disposable site of each supported type, confirm it appears, then remove it through the original CloudPanel UI.
6. Confirm the original panel on port 8443 still works.

## Commands

```bash
npx pnpm@10.12.1 dev
npx pnpm@10.12.1 typecheck
npx pnpm@10.12.1 lint
npx pnpm@10.12.1 test
npx pnpm@10.12.1 build
npx pnpm@10.12.1 start
```

## Project layout

```text
src/app                 pages and application-owned API routes
src/components          auth, layout, sites, and local UI components
src/schemas             shared browser/server validation
src/server/auth         opaque application sessions
src/server/cloudpanel   mock and version-isolated live adapters
src/server/security     origin checks, limits, and redacted logs
src/types               CloudPanel adapter contracts
```
