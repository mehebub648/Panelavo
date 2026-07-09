# Server Panel

A small, modern Next.js frontend for an existing CloudPanel installation. CloudPanel remains the source of truth for accounts, passwords, MFA, roles, site assignments, runtime support, and server-side permissions. This application creates no user database and communicates locally through CloudPanel's CLI and a read-only Symfony CLI bridge. It never accesses or scrapes the CloudPanel portal.

## One-command server setup

On a fresh Debian 11/12/13 or Ubuntu 22.04/24.04/26.04 server, clone (or upload) this repository and run:

```bash
sudo bash setup.sh
```

The script detects the OS, installs CloudPanel if it is missing, creates the initial CloudPanel admin, installs nvm + the latest Node.js for root, installs a shared PM2 into `/usr/local` usable by every user, creates a CloudPanel Node.js site owned by the system user `clp-pro`, deploys and builds this app inside it, and hosts it with PM2 (with systemd persistence across reboots). When it finishes it prints the panel URL (`http://<server-ip>:10443`) and the generated credentials. Overrides: `PANEL_DOMAIN`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`, `DB_ENGINE` — e.g. `sudo PANEL_DOMAIN=panel.example.com bash setup.sh`. The script is idempotent: re-running skips everything that already exists.

## Roles

The panel exposes four roles on top of CloudPanel's three native ones:

| Panel role    | Backed by CloudPanel | Capabilities                                                                                   |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| Super Admin   | `admin`              | Everything, including user management.                                                          |
| Manager       | `site-manager`       | All sites and site creation — everything except user management.                               |
| Admin         | `user` + local flag  | Creates websites; sees and manages only sites assigned to them plus sites they created.        |
| User          | `user`               | Sees only assigned sites; cannot create or manage anything else.                                |

The "Admin" tier is stored as a CloudPanel `user` plus an entry in `.data/panel-roles.json`, so CloudPanel itself keeps restricting their site list. Sites an Admin creates are automatically assigned to them; other users' sites stay invisible to them. Role changes and deletes made from the Users page keep the overlay in sync.

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

Copy `.env.example` to `.env.local`. Use `CLOUDPANEL_MODE=mock` for local UI work or `CLOUDPANEL_MODE=live` for the installed panel. Live mode requires non-interactive sudo access to `/usr/bin/clpctl` and `/usr/bin/php` for the local CLI bridge.

The application cookie is opaque, `HttpOnly`, `SameSite=Strict`, scoped to `/`, and `Secure` in production. Sessions expire after `SESSION_MAX_AGE_SECONDS`. The initial session store is process memory, so production must run a single Next.js process. Replace the isolated store in `src/server/auth/session.ts` before horizontal scaling or zero-downtime multi-process restarts.

## Tested CloudPanel CLI integration

The live adapter was developed against the CloudPanel installation on this host on 2026-07-08:

- Frontend asset version: **2.5.4**
- CLI version: **6.0.8**
- Panel origin: configured by `CLOUDPANEL_BASE_URL` (locally observed on HTTPS port 8443)

Root operations use `/usr/bin/clpctl`. CloudPanel does not expose password verification, MFA verification, or site listing through public `clpctl` commands, so `scripts/cloudpanel-bridge.php` boots CloudPanel's own Symfony kernel from the command line and uses its password data, MFA verifier, Doctrine entities, roles, and site assignments directly. The bridge is read-only. CloudPanel's original frontend remains untouched and is never contacted.

### Authentication and authorization

After the CLI bridge accepts credentials (and MFA, when enabled), the browser receives only a random application-session identifier. Every protected route revalidates the account and current role through the bridge. Restricted site lists are selected from the user's CloudPanel assignments before they reach the browser.

Create permission is derived from CloudPanel's Admin and Site Manager roles. Unknown roles do not receive elevated access.

### Site list

The bridge loads sites through CloudPanel's own Doctrine entities. Admins and Site Managers receive all sites; restricted users receive only their assigned collection.

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
   Also set a separate `CREDENTIALS_ENCRYPTION_KEY` (32+ characters) and `SERVER_PUBLIC_IP` for Cloudflare-managed A records.
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
