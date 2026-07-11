# panelavo

panelavo is a small, modern Next.js companion interface for CloudPanel servers. CloudPanel remains the source of truth for accounts, passwords, MFA, roles, site assignments, runtime support, and server-side permissions. panelavo creates no user database and communicates locally through CloudPanel's CLI and a read-only Symfony CLI bridge. It never accesses or scrapes the CloudPanel portal.

panelavo works over CloudPanel, but it is not affiliated with, endorsed by, or sponsored by CloudPanel.

## One-command server setup

On a fresh Debian 11/12/13 or Ubuntu 22.04/24.04/26.04 server, clone this repository and run the installer from the repo root:

```bash
git clone https://github.com/<your-org>/panelavo.git
cd panelavo
sudo bash setup.sh
```

The script detects the OS, installs CloudPanel if it is missing, creates the initial panelavo Super Admin using CloudPanel's `admin` role, installs the latest Node.js and publishes a non-root-readable runtime under `/usr/local/lib/panelavo-node`, installs a shared PM2 into `/usr/local`, creates a CloudPanel Node.js site, deploys and builds panelavo inside it, and hosts it with PM2 with systemd persistence across reboots. Corepack is optional; setup uses the pinned pnpm release through `npx` when Node.js does not bundle Corepack. It updates an already-active UFW firewall, but never activates an inactive firewall during remote setup unless `ENABLE_UFW=true` is explicitly supplied.

When it finishes, it prints the panel URL (`http://<server-ip>:10443`) and Super Admin credentials. By default, the CloudPanel site/system user is `panelavo`. The existing `ADMIN_USER`, `ADMIN_PASSWORD`, and `ADMIN_EMAIL` environment names configure this Super Admin for backward compatibility. Other overrides include `PANEL_DOMAIN`, `PANEL_BASE_DOMAIN`, `PANEL_SITE_USER`, `DB_ENGINE`, and `ENABLE_UFW`. Example:

```bash
sudo PANEL_DOMAIN=panelavo.example.com PANEL_BASE_DOMAIN=example.com bash setup.sh
```

The script is idempotent: re-running skips resources that already exist.

### SSH lockout protection and recovery

The normal customer workflow remains `git clone` followed by `sudo bash setup.sh`; no security preflight is required. Setup leaves fail2ban's `sshd` jail active because provisioning does not make SSH authentication attempts. Set `KEEP_FAIL2BAN_SSHD_RUNNING=true` only to request a temporary exemption for the detected client IP; the exemption is removed automatically on exit. Because `sudo` can remove `SSH_CONNECTION`, setup recovers the live connection from its process ancestry and preserves the actual SSH port when preparing UFW rules.

The provider-console procedure below is recovery only for a machine whose client was already banned; it is not part of normal installation:

```bash
fail2ban-client set sshd unbanip <client-ip>
```

Older setup versions may have left fail2ban with no active jails. Restore its configured jails from the provider console before reconnecting:

```bash
systemctl restart fail2ban
fail2ban-client status
```

After setup, `fail2ban-client status sshd` should still show the active jail. `FAIL2BAN_SSHD_PREPAUSED=true` remains available only for recovery workflows where an operator deliberately stopped the jail before starting setup.

If SSH times out, use the hosting provider's VNC/serial/web console. Do not assume fail2ban without checking:

```bash
fail2ban-client status sshd
journalctl -u fail2ban --since "30 minutes ago"
ufw status numbered
ss -lntp | grep -E ':(22|2222)\\b'
```

If the connection dropped immediately after setup printed `Enabling ufw`, recover from the provider console with `ufw disable`, confirm SSH works, and review `ufw status numbered` before enabling it again. Current setup versions do not activate inactive UFW remotely by default.

If the client IP appears in `Banned IP list`, recover with `fail2ban-client set sshd unbanip <client-ip>`. If it is not banned, check the provider firewall/security group and `journalctl -u ssh --since "30 minutes ago"`. A timeout means packets are being dropped or cannot reach sshd; it does not by itself prove a fail2ban ban. Do not leave the `sshd` jail stopped after maintenance.

## Roles

panelavo exposes four roles on top of CloudPanel's three native ones:

| panelavo role | Backed by CloudPanel | Capabilities                                                                            |
| ------------- | -------------------- | --------------------------------------------------------------------------------------- |
| Super Admin   | `admin`              | Everything, including user management.                                                  |
| Manager       | `site-manager`       | All sites and site creation, except user management.                                    |
| Admin         | `user` + local flag  | Creates websites; sees and manages only sites assigned to them plus sites they created. |
| User          | `user`               | Sees only assigned sites; cannot create or manage anything else.                        |

The "Admin" tier is stored as a CloudPanel `user` plus an entry in `.data/panel-roles.json`, so CloudPanel itself keeps restricting their site list. Sites an Admin creates are automatically assigned to them; other users' sites stay invisible to them. Role changes and deletes made from the Users page keep the overlay in sync.

## Stack

Next.js App Router, strict TypeScript, Tailwind CSS, shadcn-style local UI components, Lucide, Zod, pnpm, ESLint, Prettier, and Vitest.

## Local development

```bash
cp .env.example .env.local
# Set SESSION_SECRET to: openssl rand -base64 32
npx pnpm@10.12.1 install
npx pnpm@10.12.1 dev
```

Open `http://localhost:3000`. The app always talks to a real local CloudPanel installation, so development needs the same `/usr/bin/clpctl` and `/usr/bin/php` sudo access as production.

## Environment

Copy `.env.example` to `.env.local`. panelavo talks to the installed CloudPanel CLI and local bridge; non-interactive sudo access to `/usr/bin/clpctl` and `/usr/bin/php` is required. `setup.sh` installs the required sudoers rule for the CloudPanel site user.

The application cookie is opaque, `HttpOnly`, `SameSite=Strict`, scoped to `/`, and `Secure` in production. Sessions expire after `SESSION_MAX_AGE_SECONDS`. The initial session store is process memory, so production must run a single Next.js process. Replace the isolated store in `src/server/auth/session.ts` before horizontal scaling or zero-downtime multi-process restarts.

## Tested CloudPanel CLI integration

The live adapter was validated against CloudPanel frontend asset version **2.5.4** and CLI version **6.0.8**. All CloudPanel access is local (CLI + bridge); no CloudPanel URL needs to be configured.

Root operations use `/usr/bin/clpctl`. CloudPanel does not expose password verification, MFA verification, or site listing through public `clpctl` commands, so `scripts/cloudpanel-bridge.php` boots CloudPanel's own Symfony kernel from the command line and uses its password data, MFA verifier, Doctrine entities, roles, and site assignments directly. The bridge is read-only. CloudPanel's original frontend remains untouched and is never contacted.

### Authentication and authorization

After the CLI bridge accepts credentials and MFA when enabled, the browser receives only a random application-session identifier. Every protected route revalidates the account and current role through the bridge. Restricted site lists are selected from the user's CloudPanel assignments before they reach the browser.

Create permission is derived from CloudPanel's Admin and Site Manager roles. Unknown roles do not receive elevated access.

### Site list

The bridge loads sites through CloudPanel's own Doctrine entities. Admins and Site Managers receive all sites; restricted users receive only their assigned collection.

### Site identity: categories, ids, and domains

panelavo chooses each website's primary system domain. On creation the user picks a project category; the next free id in that category's range becomes the site id, the application port, and the site user:

| Category                   |    Port range |
| -------------------------- | ------------: |
| Client projects            | `20000-20999` |
| Personal projects          | `21000-21999` |
| Business/SaaS projects     | `22000-22999` |
| Relatives/Friends projects | `23000-23999` |
| Demo/Preview projects      | `24000-24999` |
| Internal tools             | `25000-25999` |
| Reserved/Future            | `26000-29999` |

A site with id `23223` is created as `site-23223.<server-ip>.<base domain>` with site user `site-23223` listening on port `23223`. The base domain is set at install time with `PANEL_BASE_DOMAIN`, prompted by `setup.sh`, and reconfigurable later from the panel (Settings → Change). Changes apply to future sites. The panel itself is served on `panel.<server-ip>.<base domain>`, covered by the same wildcard record, and its own CloudPanel site is hidden from the panel's website list. Reservations live in `.data/site-meta.json`; the port is movable from the site's Settings tab.

Customer-entered domains are aliases: the Domains tab and create form add them to the vhost `server_name`, point DNS through the panel-wide Cloudflare token when it manages the zone, and issue Let's Encrypt certificates covering selected domains. The system subdomain can be blocked with 403 or redirected to an alias; ACME challenge paths stay reachable so renewals keep working.

### Site creation

CloudPanel does not document a public REST API for site creation. Version 2.5.4's documented `clpctl` operations are used through `/usr/bin/clpctl`. The Node process calls `/usr/bin/sudo` with an argument array, `shell: false`, a fixed per-type operation map, validation, a 90-second timeout, bounded output, and generic errors. There is no generic command endpoint and no browser-supplied CLI operation.

### Git repositories

The Git section can initialize an existing site root or clone into an empty one. A root containing only the ACME-managed `.well-known` directory is also accepted; that directory is preserved while the repository is checked out. SSH clones use the site user's deployment key, accept and persist a previously unseen host key on first connection, and run non-interactively. Add the public deployment key shown under SSH/FTP to private repositories before cloning. Repository operations have a five-minute limit and return actionable errors for other non-empty roots, authentication failure, and an invalid repository or branch.

### File uploads

The file manager accepts individual files up to 64 MiB. Because uploads are base64-encoded JSON, `setup.sh` idempotently configures the panel's Nginx vhost with a 96 MiB request-body allowance and validates the configuration before reloading Nginx.

### Panel updates

Super Admins can check and install Panelavo updates from Settings. The default source is the public `https://github.com/mehebub648/Panelavo.git` repository on `main`; the public HTTPS repository URL can be changed and is persisted in `.data/panel-settings.json`. Panelavo clones into a private staging directory, installs the locked dependencies, and requires a successful production build before synchronizing the release. `.data` and `.env.local` are preserved. Only the `panelavo` PM2 process reloads, so managed websites are not restarted.

The updater intentionally runs as the panel site user, not root. Host-level migrations are never executed automatically; release notes must identify any required root maintenance. Update progress and failures persist in `.data/update-state.json` and `.data/update.log`.

The installer grants the CloudPanel site user narrow passwordless sudo for:

```text
NOPASSWD: /usr/bin/clpctl, /usr/bin/php
```

Do not grant `clpctl *`, `bash *`, `sh *`, or unrestricted sudo to a deployment user. For stronger production isolation, replace the current permission with root-owned per-operation wrappers that accept only validated fields.

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

1. Set a strong `SESSION_SECRET`.
2. Set a separate `CREDENTIALS_ENCRYPTION_KEY` with at least 32 characters.
3. Confirm a trusted TLS chain, or explicitly accept the documented development-only risk.
4. Test an admin, site manager, restricted user, MFA user, and invalid password.
5. Confirm the restricted account sees exactly its assigned sites and cannot call `POST /api/sites`.
6. Create a disposable site of each supported type, confirm it appears, then remove it through the original CloudPanel UI.
7. Confirm the original CloudPanel interface on port 8443 still works.

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
src/server/cloudpanel   version-isolated live CloudPanel adapter
src/server/security     origin checks, limits, and redacted logs
src/types               CloudPanel adapter contracts
```
