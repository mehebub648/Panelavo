# Deployment & Operations (PM2)

panelavo runs as a **production** Next.js server managed by
[PM2](https://pm2.keymetrics.io/). Process name: **`panelavo`** — private
listener **`127.0.0.1:10443`**, proxied only through the HTTPS CloudPanel vhost.

On a fresh server, `sudo bash setup.sh` does everything below automatically
(CloudPanel install, site creation, build, PM2, boot persistence). This
document is for manual operation and updates afterwards. Run all commands as
the panel's site user from the application directory
(`/home/<site-user>/htdocs/<panel-domain>`).

Generated Admin and site-user credentials are staged in `/root/.panelavo-setup-credentials` with mode 0600 before their accounts are created. If a later installation step fails, rerunning setup reuses the pending credentials; the file is deleted only after the successful summary is printed. An explicitly supplied `ADMIN_PASSWORD` resets the matching existing active Admin during a retry.

---

## Prerequisites (one time)

1. **Node 20+ / pnpm on PATH.** PM2's daemon uses a minimal environment, so
   `ecosystem.config.js` calls Next's binary directly and does not need pnpm.
   You only need pnpm for `install` / `build`. Node.js releases do not always
   bundle Corepack, so the portable command is:

   ```bash
   npx -y pnpm@10.12.1 --version
   ```

2. **Environment.** Copy `.env.example` to `.env.local` and fill it in
   (setup.sh generates one automatically). For production make sure:

   | Variable                     | Notes                                                                                           |
   | ---------------------------- | ----------------------------------------------------------------------------------------------- |
   | `SESSION_SECRET`             | **≥ 32 chars.** Required in production or the app refuses to start.                             |
   | `CREDENTIALS_ENCRYPTION_KEY` | Separate ≥ 32-char secret for encrypting Cloudflare tokens.                                     |
   | `PANEL_ADDRESS_MODE`         | `sslip` (recommended/default) or `custom`; inferred from the base domain for existing installs. |
   | `PANEL_BASE_DOMAIN`          | Custom base domain, or `sslip.io` for the recommended mode.                                     |
   | `PANEL_UPDATE_REPOSITORY`    | Optional public HTTPS `.git` updater source; setup can infer a compatible checkout origin.      |

   All host-specific values are detected dynamically — you do **not** need to
   set `APP_BASE_URL` or `SERVER_PUBLIC_IP`:

   - The CSRF origin check compares the request `Origin` against the HTTP
     `Host` preserved by Nginx. It deliberately does not trust a supplied
     `X-Forwarded-Host` value.
   - The server's public IP for DNS "pointed" checks is auto-detected
     (`SERVER_PUBLIC_IP` still works as an optional override).
   - The Databases section links to the standalone phpMyAdmin database
     manager. `DATABASE_MANAGER_URL` (written by `setup.sh` after it
     provisions the site) overrides the derived
     `https://database.<ip>.<base-domain>` address.
   - The session cookie's `Secure` flag follows Nginx's trusted
     `X-Forwarded-Proto`. Public login is HTTPS-only; port 10443 is bound to
     loopback and is available only through an explicit SSH recovery tunnel.
   - Do **not** set `NODE_ENV` in `.env.local` — Next ignores it in `start`
     mode and it only causes confusion. PM2 sets `NODE_ENV=production`.

---

## Build

A production build is required before (re)starting. Run it after every code
change, from the application directory:

```bash
pnpm install --frozen-lockfile   # only when dependencies changed
pnpm build
```

---

## Run

Start (or restart) under PM2 using the committed config:

```bash
pm2 start ecosystem.config.js
```

Persist the process list so it survives a reboot:

```bash
pm2 save                 # snapshot the current process list
pm2 startup              # prints a one-time `sudo ...` command — run it once
```

The panel is now reachable on `https://<panel-domain>` (proxied to the private
`127.0.0.1:10443` listener). Never publish that listener directly.

The same public HTTPS vhost also serves the remote MCP endpoint at `https://<panel-domain>/mcp` and its same-origin OAuth routes. No additional server listener, firewall rule, OAuth secret, or environment variable is required. Users may create expiring personal MCP tokens from **AI access** and keep them in a client-side environment variable, or use the OAuth browser-sign-in alternative. `setup.sh` narrows CloudPanel's direct-file `/.well-known` location to ACME challenges so MCP discovery reaches Panelavo through the ordinary proxy. The canonical issuer/resource comes from the configured panel self-domain, so MCP is deliberately unavailable through an alternate host or insecure production request. Keep Nginx's original `Host` and trusted `X-Forwarded-Proto` behavior; the existing long proxy timeout bounds synchronous MCP Operations and Backups, while background MCP jobs return immediately and enforce their own maximum 30-minute timeout. After upgrading from a version without MCP, run the frozen dependency install and production build before reloading Panelavo.

Background MCP job state lives in private `.data/mcp-jobs.json` and is preserved by normal Panelavo upgrades. Keep Panelavo as one PM2 process: cancellation controllers and active broker process groups are process-local, while a restart deliberately changes any orphaned queued or running record to `interrupted`. This release does not change the root broker protocol and therefore does not require a new trusted setup run when protocol 14 is already healthy.

The file manager accepts base64 JSON files up to 64 MiB. MCP artifact sessions accept resumable raw chunks up to 32 MiB and complete files up to 2 GiB only when the declared SHA-256 matches. Run `sudo bash setup.sh` after upgrading so the panel vhost receives its required `client_max_body_size 96m` and `proxy_request_buffering off` directives. Setup validates Nginx and restores the previous vhost if validation fails. Chunk requests remain authenticated on every call and are bound to the originating MCP credential and current writable-site access.

The phpMyAdmin database manager accepts SQL imports up to 512 MiB: setup writes a `.user.ini` with matching PHP upload/execution limits into the manager's document root, raises phpMyAdmin's execution cap, and adds a `client_max_body_size 512m` directive (plus one-hour FastCGI timeouts) to the manager vhost with the same validate-and-restore safety net. Existing installs pick this up on the next `sudo bash setup.sh` run.

Super Admins can perform normal application updates from Settings. The update check shallow-fetches the candidate release metadata, compares its stable semantic version with the installed version, and verifies the installed root broker before enabling installation. It never labels an older repository release as latest, never installs a different commit that reuses the installed version, and sends update notifications only for a strictly newer, broker-compatible release. The worker independently repeats the version-direction and broker checks after cloning, then verifies that the deployed application directories are writable by the panel site user, builds in staging, and preserves `.data` and `.env.local` while deploying and reloading only the Panelavo PM2 process. Release synchronization does not preserve staged owner or group metadata. Trusted `setup.sh` repairs legacy root-ownership drift before its root-run deployment and leaves the application tree site-user-owned. The updater never runs `setup.sh` or a root migration. Before the first update from 0.1.36 or older, run `sudo bash setup.sh` from a trusted checkout once; later incompatible broker releases are blocked before deployment with the installed and required protocol shown when they can be identified. Other expected validation failures are also shown there, while unexpected build or deployment failures point to the private update log. A successful trusted setup reconciles the persisted updater state to the version and commit it installed, clearing any stale failed-update marker without replacing the configured repository.

## Managed website Operations

The Operations tab manages applications hosted by CloudPanel; it is separate from updating Panelavo itself. CloudPanel's [configured site type](https://www.cloudpanel.io/docs/v2/frontend-area/add-site/), runtime, serving/document root, app port, and reverse-proxy upstream remain authoritative for web traffic. Panelavo stores an optional application-root override in `.data/site-roots.json` for Git, File Manager, Terminal defaults, Environment, Operations, cron working-directory guidance, and backups. Both paths stay within `/home/<site-user>/htdocs`; when no override exists, the CloudPanel serving root is also the application root. Panelavo inspects only that application root and reports architecture evidence separately from runtime/tool availability, permission, configuration validity, and safety checks. A root-level Compose file always wins, but when none exists Panelavo also discovers a Compose file kept in a subfolder (for example `docker/`) via a bounded, deterministic scan that skips dependency and VCS trees. Apart from locating that single Compose file, it does not recursively search a repository for deployable apps.

`setup.sh` installs the host ACL, uidmap, D-Bus user-session, and slirp4netns prerequisites used by the root-owned broker. ACL enforcement stays under `/home/<site-user>/htdocs`, grants the site user named `rwX`, and applies default directory entries for future descendants. Existing installations must run the trusted `setup.sh` once when upgrading to broker protocol 10 so the root-owned bridge can execute narrowly allow-listed scheduled backups, private off-site staging, self-service CloudPanel MFA enrollment, and atomic pull-plus-operation plans; the ordinary in-panel updater intentionally cannot install host packages or replace the root-owned broker.

Broker protocol 11 adds the website-attributed resource snapshot and its bounded root-owned process/container inspection. Existing installations must run the trusted `setup.sh` before deploying a protocol 11 application release. The in-panel updater refuses the release while protocol 10 is installed, preventing the new Resources UI from running against the older response contract.

Broker protocol 12 adds the on-demand whole-filesystem storage analysis used by Disk details. Existing installations must run the trusted `setup.sh` before deploying a protocol 12 application release; the in-panel updater refuses this release while protocol 11 is installed. The scan runs only when requested, uses low CPU and idle-I/O priority, is bounded to five minutes, and caches complete results for thirty minutes. It reads allocation metadata only and never prunes Docker, deletes files, or changes hosted sites.

Broker protocol 13 adds the Super Admin-only safe BuildKit cache reclaim used by Disk details. Existing installations must run the trusted `setup.sh` before deploying a protocol 13 application release; the in-panel updater refuses this release while protocol 12 is installed. Cleanup is explicitly confirmed, host-wide serialized, and sequential across exact rootless site-user sockets. It runs only when Docker supports `--max-used-space`, retains up to 5 GB of build cache per site, and never prunes containers, images, volumes, databases, backups, or application files.

Broker protocol 14 adds contained tar.gz/tgz compression and extraction to the site File Manager and MCP section tool. The bridge lists tar members before extraction, rejects traversal, links, and special entries, and extracts only as the site user. Existing installations must run trusted `setup.sh` before deploying this application release; setup also installs the streaming proxy directive used by resumable MCP artifacts.

Broker protocol 15 adds checksum-bound managed artifact releases. Existing installations must run trusted `setup.sh` before deploying a protocol 15 application release; the in-panel updater refuses it while protocol 14 is installed. The release root must be a directory below the site's `htdocs` and cannot contain another mounted filesystem. Node.js, static-build, PHP, and Python releases use an atomic application-root pointer plus public HTTPS health gating and automatic rollback. Existing managed environment files are preserved. At most ten versioned site-user-owned releases are retained. Compose releases remain blocked until their bind mounts and datastores can be covered by the data-aware deployment contract.

Broker protocol 16 adds explicit MCP recovery routing for configured proxy diagnosis, contained site ACL repair, one-site private rootless-runtime restart, and journaled rootful-to-rootless migration recovery. Existing installations must run trusted `setup.sh` before deploying a protocol 16 application release. These are fixed broker operations rather than a privileged terminal: MCP supplies only the site and an enum, the broker rechecks the live role and assignment, and migration recovery remains Super Admin-only.

Broker protocol 17 adds selective LanceDB table snapshots and validated restore/swap for safe rootless Compose sites. Existing installations must run trusted `setup.sh` before deploying a protocol 17 application release. Snapshot and restore briefly stop only the selected site's Compose project, so use a real readiness path such as `/ready`; optional numeric JSON checks should cover business-critical counts. The broker accepts only physical application-root-relative datastore paths and whole validated `.lance` directories. It checks the stored SHA-256 before restore and puts prior tables back when restart, readiness, or data validation fails. A killed host process cannot promise application-level atomicity, so operators should retain a normal whole-site backup for disaster recovery.

Broker protocol 18 adds ownership-aware Project Endpoint inventory and verification. Existing installations must run trusted `sudo bash setup.sh` before deploying a protocol 18 application release. The bridge exposes only high loopback listeners owned by the parent site's Unix boundary, rejects foreign, wildcard/public, and CloudPanel-reserved ports, and performs a bounded site-user HTTP check before activation. Pending reservations create no public proxy. Active endpoint changes are health-gated and restore the previous NGINX upstream when the post-change check fails.

Broker protocol 19 makes website creation return the authoritative CloudPanel site record. Existing installations must run trusted `sudo bash setup.sh` before deploying a protocol 19 application release; this keeps creation-time labels bound to the real upstream record instead of a temporary local identity.

Broker protocol 20 adds fingerprinted fresh-PHP-site scaffold replacement during Git clone. Existing installations must run trusted `sudo bash setup.sh` before deploying a protocol 20 application release. Only unchanged creation-time regular files are eligible; the bridge preserves ACME state, clones into staging first, restores the scaffold on promotion failure, and keeps every other non-empty root blocked.

Broker protocol 21 adds the site-scoped Operations port-source repair. Existing installations must run trusted `sudo bash setup.sh` before deploying a protocol 21 application release. The bridge edits only one unique numeric `.env` `PORT` or literal short Compose entry mapping, refuses conflicting/ambiguous evidence and non-port Compose safety failures, validates a staged source, retains a verified root-owned backup, installs the source atomically, and never restarts the website automatically.

Broker protocol 22 adds host-wide port reservation inventory, ownership-aware readiness, and collision checks at create, settings-update, deploy, and final verification time. It also moves default managed application ports to 30000–39999 while keeping site ids stable. Existing installations must run trusted `sudo bash setup.sh` before deploying a protocol 22 application release.

Broker protocol 23 adds the production database gateway, host maintenance inventory, automatic disk-pressure cleanup, and the direct-`clpctlWrapper` denial boundary. Trusted `sudo bash setup.sh` is mandatory before deploying this release: setup first refuses active non-loopback database clients, makes ports 3306/33060 loopback-only, installs the dedicated ProxySQL and Nginx Stream layers, provisions a localhost-only TLS monitor for ProxySQL, prepares firewall rules for managed ports 43000–43255, and validates the complete fail-closed gateway contract. Supply `DATABASE_GATEWAY_CERTIFICATE_FILE`, `DATABASE_GATEWAY_PRIVATE_KEY_FILE`, and optionally `DATABASE_GATEWAY_CA_FILE` for a publicly trusted wildcard identity; otherwise the installer creates a private Panelavo client CA. A later gateway fault closes endpoints but does not block panel authentication or ordinary site management. The ordinary updater cannot perform these root-owned changes.

Broker protocol 24 adds the Super Admin-only WireGuard host gateway and its non-mutating broker self-test. Existing installations must run trusted `sudo bash setup.sh` from this release before the in-panel updater can deploy the protocol-24 application. VPN installation itself remains explicit and on demand from `/vpn`; trusted setup installs only the updated root-owned broker and does not alter routes, forwarding, firewall state, or install WireGuard packages.

Connected servers use application peer protocol 1 and broker protocol 24; this redesign requires no installer, broker, port, or firewall changes. Run Panelavo 0.1.121 or newer on both panels for native-interface switching through signed peer actions. Each panel requires a publicly resolvable hostname with a valid certificate on HTTPS port 443. Private-only addresses, custom ports, self-signed certificates, and redirects remain unsupported. Normal pages prohibit framing; connected-server switching does not require third-party cookies, cross-origin frames, or proxy-header changes.

To change a panel address, first add the new domain's DNS and a CloudPanel alias on the existing panel site, then issue its certificate. Do not move the app directory or remove the old vhost. Use Settings → Panel address to verify the new endpoint and notify all direct peers. Preserve `.data/panel-address.json`, including pending migration progress, with the rest of runtime state. If any peer is unavailable or outdated, keep both domains routed to this installation and retry the pending change after recovery. The current canonical origin stays unchanged until all peers acknowledge. Personal OAuth clients can require reconnection after the issuer changes; unrelated websites and server trust keys are untouched.

Preserve all of `.data` and `.env.local` on deployment. Existing `.data/fleet-state.enc.json` identities and pinned connections migrate from a single incoming grant to multiple independent incoming grants without changing keys. Legacy wire identifiers and protocol 1 are retained for compatibility, but installations no longer have exclusive Hub/Node roles. Back up state before upgrading; an older binary does not understand multiple incoming grants, so rolling back this migration requires deliberate state recovery rather than silently dropping connections.

A token is created in one click by a signed-in Super Admin and submitted by a signed-in Super Admin on the server granting access. Tokens expire after ten minutes and are single-use. Generate a separate token for each direction and each server. Deployment never creates or expands grants, and disconnecting never changes hosted apps. No Node password, browser session, or private signing key is forwarded to the managing panel. Existing `.data/delegated-tickets.enc.json` files from v0.1.119-v0.1.120 are unused and may be retained harmlessly during upgrade; do not delete `.data` during deployment.

Remote panel controls (v0.1.122): full-scope Super Admin connections expose panel address changes, server sharing and user invitations on the selected server. Both panels must run this release; older limited links require reauthorization. Address changes retain the existing same-panel HTTPS proof and peer acknowledgement flow. Remote pages request only their section; account/site reads are deduplicated only within a server render, and host software inventory is cached for 30 seconds after checking live authority. Deployment needs no broker or hosted-application restart.
Navigation completion observes both pathname and query string so switching remote tabs does not leave the loading overlay blocking an already rendered page.

### Concurrent session persistence

Session startup shares one disk load, and atomic saves run in order. Refreshes cannot restore revoked sessions. Persistence failures remain best-effort and are retried on later requests; no session format or deployment migration is required.

### Bounded Fleet health sweeps

The minute-based Fleet scheduler skips ticks while its previous sweep is running, including across module reloads. Failed sweeps release the guard so monitoring resumes on the next tick. Existing per-sweep concurrency remains bounded; deployment requires no broker or data migration.

### Adaptive update status polling

Visible idle tabs check update status once per minute, switching to every two seconds when an update is detected. Hidden tabs pause checks and refresh when visible again. Requests never overlap and are cancelled on hiding or unmounting; the maintenance lock survives transient failures. This frontend change needs only the normal panel build and reload.

### Lightweight remote health reports

Background Fleet checks request a compact authenticated health report from the shared minute resource sampler, avoiding site lists, software inventory and detailed runtime scans. Samples older than two minutes are omitted. Full summaries remain available on demand, and older peers remain compatible by returning their existing summary. Deploying peers one at a time requires no protocol or broker upgrade.

### Separate Fleet telemetry and replay persistence

Fleet health and replay records now use separate encrypted files, so routine requests do not rewrite connection credentials. Replay identifiers are saved before requests are accepted; missing or corrupt replay state fails closed. Migration merges existing records before marking the split complete, and health cannot reactivate pending or suspended connections. Preserve all three fleet-*.enc.json files in backups. Before downgrading below v0.1.127, stop Panelavo for at least five minutes to expire all previously signed requests; never delete the replay file from a running installation.

### Bounded concurrent website monitoring

Website uptime and TLS checks run through four workers instead of a sequential queue. A slow or failing site no longer delays every later site, while the existing twelve-second network limits, failure thresholds and recovery alerts remain in place. HTTPS response bodies are cancelled after checking headers to release resources. Only the Panelavo process needs reloading; hosted applications are unchanged.
### Connected-server information

Panelavo v0.1.129 enriches the existing authenticated `system.info` Fleet action with the configured panel origin and public address families. No Fleet protocol or broker upgrade is required. Deploy connected nodes before the host for the complete response during rollout; the host UI falls back to the earlier response shape until each node is upgraded.

### PHP website creation ports

PHP creation checks the selected runtime's next CloudPanel pool port against reserved ports and live listeners. A conflict blocks only that PHP version and asks the user to choose another; unrelated legacy application ports no longer block all PHP creation. Panelavo creation requests are serialized. Deploy the updated root-owned bridge with v0.1.131; existing sites and Admin assignment boundaries remain unchanged.

The self-updater resolves PM2 from the panel site user's PATH before staging and uses that executable to reload only Panelavo. Both shared /usr/local/bin and distribution /usr/bin installations are supported; missing PM2 blocks before deployment.

Legacy MCP clients use credential- and live-actor-bound in-memory HTTP sessions so negotiated elicitation capabilities and confirmation replies survive across requests. Sessions expire after 30 minutes of inactivity, are capped globally and per credential, and are lost on a Panelavo restart; clients must initialize again. Every HTTP request still authenticates against live CloudPanel access. Modern per-request MCP handling and one-use confirmation checks remain unchanged.
