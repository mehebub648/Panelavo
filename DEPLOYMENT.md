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

An inactive UFW installation is never activated from SSH unless both `ENABLE_UFW=true` and `UFW_CONSOLE_RECOVERY_READY=true` are supplied after provider-console recovery has been tested. The second flag is intentionally a separate acknowledgement because a malformed or provider-incompatible firewall can otherwise remove the only administrative path to the server.

The single Panelavo process starts backup, monitoring, database-gateway reconciliation, and storage-hygiene schedulers at server boot rather than waiting for an administrator to open the UI. Automatic storage cleanup starts at 75%, uses a six-hour normal cooldown, tightens at 90% with a one-hour cooldown, and blocks storage-growing application actions at 92% or below the dynamic 2–10 GB reserve. It never prunes volumes, containers, databases, backups, or application files. `setup.sh` enables the operating system's daily unattended security updates without automatic reboot; the Information page reports pending packages and a required reboot.

S3-compatible backup destinations require an HTTPS endpoint and `CREDENTIALS_ENCRYPTION_KEY` (or the existing 32-character-or-longer `SESSION_SECRET`). The configured bucket credentials need list, read, write, and delete access only under the chosen site prefix. No bucket credentials are installed into the root broker.

SMTP and webhook notification settings use the same credential-encryption key. Permit outbound TCP to the configured SMTP host/port and outbound HTTPS to the webhook receiver; Panelavo does not require an inbound notification port.

Uptime and certificate monitoring also require outbound DNS and HTTPS/TLS access from the Panelavo process. Checks originate from the managed server, run in the single PM2 process, and persist their debounce/last-check state under `.data`; do not configure multiple Panelavo workers.

The root contracts currently cover npm, pnpm, Yarn, and Bun projects; Composer, Laravel, and WordPress; uv, Poetry, Pipenv, pip virtual environments, and Django; direct static roots; reverse-proxy checks; PM2; and Docker Compose. A workspace needs usable root scripts or explicit root-level configuration. For a generated static site, configure CloudPanel to serve a verified build directory yourself: Panelavo does not infer `dist`, `build`, `out`, or another output and does not change the document root.

Every Operations request sends a validated action, plan, or fix identifier to the server. The server chooses the executable and arguments, fixes the working directory, runs without a shell, bounds runtime and output, and holds a per-site lock. Recommended plans execute synchronously, stop after the first failed step, and expose each step's result. A missing executable, ambiguous dependency manager, invalid configuration, insufficient role, or failed safety rule remains a visible blocker; Operations never installs a missing tool silently or as a fallback.

Some blocked preflight checks additionally offer an explicit one-click fix. Host-software fixes are Super Admin-only, individually confirmed, and serialized host-wide. Docker initialization verifies or installs Engine/CLI, Compose v2, Buildx, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, and `slirp4netns`, then configures linger and the site's systemd user daemon; Docker packages come from the official APT repository. Composer comes from getcomposer.org with installer signature verification.

Every Node.js, Python, reverse-proxy, or Compose application is checked against CloudPanel's configured upstream/app port. New Panelavo-managed applications derive ports in 30000–39999 from their stable 20000–29999 site ids; legacy custom ports remain supported. For a site whose configured port is `34001`, success means the site's own loopback process responds on `127.0.0.1:34001`; a foreign listener on `34001` blocks deployment, while a site process listening only on `3000` is reported as a mismatch. Node/Python PM2 starts receive the expected port and loopback host environment, and plans recheck listener ownership before probing the endpoint after startup.

For Compose, Panelavo determines the public entry service from an existing exact mapping, an explicit `io.panelavo.entrypoint=true` label, a unique candidate, the service dependency graph, or an unambiguous conventional gateway name. It determines the container port from an explicit `io.panelavo.container-port=<port>` label or consistent Compose port, environment, and health-check evidence. A safe mismatch such as frontend `127.0.0.1:3000:3000` for CloudPanel port `24001` is run as `127.0.0.1:24001:3000` through an ephemeral resolved Compose configuration. The source file is not modified. Other published service ports are forced to loopback and listed as additional endpoints; create connected reverse-proxy sites when those endpoints also need public domains. If entry service or container port is ambiguous, deployment blocks and shows the labels needed instead of guessing.

The lifecycle actions intentionally distinguish **Start services** (`docker compose up -d --remove-orphans`) from **Build & start services** (`docker compose up -d --build --remove-orphans`). Use the build operation after changing a Dockerfile, build context, build arguments, or dependencies copied into an image. Both start paths verify the configured website entry port before reporting success.

### Docker Compose prerequisite and policy

`setup.sh` provisions rootless Docker host support on every server — Docker Engine, CLI, Buildx, Compose v2, `docker-ce-rootless-extras`, and `fuse-overlayfs` from Docker's official repository, alongside `uidmap`/`dbus-user-session`/`slirp4netns` — so the shared prerequisites are present out of the box. Host provisioning stays a root/Super Admin boundary: the Super Admin rootless host fix still (re)installs any missing Docker packages, allocates subordinate ranges, and validates cgroup v2/systemd, at least 65,536 non-overlapping subordinate UIDs/GIDs, functional `newuidmap`/`newgidmap`, the Buildx plugin, native rootless overlay storage (`overlay2` or Docker 29's `overlayfs`, with `fuse-overlayfs` only when the native probe fails), the user manager and D-Bus, linger, and the private socket. Once the host is provisioned, a **site-write user can self-initialize their own per-user runtime** (enable their linger, start their private daemon) with no Super Admin step; that self-service action never installs packages or allocates ranges and refuses — without mutating anything — when the host is not provisioned. Ports below 1024 are unsupported.

```bash
docker context use rootless
docker compose version
docker info --format '{{json .SecurityOptions}}'
```

Do not add the Panelavo or website user to the `docker` group. Each site user owns a daemon at `/run/user/<uid>/docker.sock` and state under `/home/<site-user>/.local/share/docker`; no Docker API is exposed over TCP and Panelavo never falls back to `/var/run/docker.sock`. The setup-created rootless context is used for SSH, without exporting `DOCKER_HOST` in `.profile`. Ordinary Compose actions — and bringing up the site user's own rootless runtime — are permitted to site-write users because they grant nothing beyond that user's SSH access; host package provisioning and rootful migration remain Super Admin-only.

For every Compose action, Panelavo supplies the selected Compose file (in the application root or a discovered subfolder), stable project name, and exact site-user socket. Preflight requires the private daemon, a valid configuration, an unambiguous entry-port contract, and the safety policy. Runtime port remapping uses a site-owned mode-0600 file in a mode-0700 `/run/user/<uid>` directory and always deletes it. Privileged features, added capabilities, devices, host/shared namespaces, unsafe security options, and out-of-root bind mounts/build contexts block. Userspace forwarding can change the peer IP visible inside containers; trust CloudPanel's configured forwarded headers rather than authorize by that immediate address.

Legacy rootful projects use **Prepare** and **Cut over**. Prepare handles one service pull/build per request while traffic remains online; requests stop at 900 seconds, after which a longer build must be completed through the site's rootless SSH context and readiness refreshed. It rejects named/external volumes, unsupported features, out-of-root paths, conflicting bind users, and ambiguous numeric owners. Cutover revalidates the expiring manifest, stops but retains rootful containers, journals ownership, maps root to the site account and non-root container IDs into its subordinate range, reapplies site-user ACLs, starts with `--no-build`, and verifies state, health, ports, access, and HTTP. Failure restores ownership/ACLs and the rootful endpoint. Never delete an incomplete recovery journal manually.

Rootless image layers are duplicated per user and readiness reports store size, reclaimable data, and free filesystem space. Rootless initialization merges a default `local` logging policy into `~/.config/docker/daemon.json`, retaining five 20 MB files unless the site already selected an external driver or a stricter compatible policy. Trusted setup likewise installs/configures `pm2-logrotate` for Panelavo. The backup archive is limited to the configured `htdocs` application root and does not include `~/.local/share/docker`. Site deletion must remove the user's rootless objects and migration state, stop/disable Docker, remove its data, disable linger, and verify the socket is gone before deleting the CloudPanel site/Unix user.

### Failure and rollback limits

Managed dependency installs and builds operate on the configured live application root. An after-pull plan can serialize the fast-forward pull and up to ten allow-listed Operations under one per-site lock, but it is still an in-place deployment. Operations currently has no release-directory staging, atomic symlink switch, automatic code rollback, or staging/clone environment. Those remain explicit roadmap items because CloudPanel's serving/document root is authoritative. Requests and child commands are synchronous and bounded; if a plan fails, earlier successful steps remain applied and later steps are skipped.

Laravel and Django migrations are deliberately excluded from recommended deployment plans and remain separately confirmed destructive actions. Panelavo does not create a database backup or guarantee a down migration. Export the relevant database and verify its restore procedure before running a migration. Static output selection and reverse-proxy cutover also remain explicit operator responsibilities.

---

## WireGuard gateway operations

The `/vpn` page installs one Panelavo-owned `pnlwg0` gateway only after its preflight passes. The default host rule required outside the server is inbound UDP `51820` to the direct public endpoint; if a different port is selected, allow that exact UDP port instead. Do not expose TCP `10443`, raw database ports, SSH, or rootless Docker ports. Panelavo never enables inactive UFW and never flushes an existing nftables ruleset. An unmanaged default-drop firewall or conflicting interface, file, route, UDP listener, or nftables table blocks installation for manual review.

Before enabling this on production, use a disposable supported VM and capture listeners, routes, forwarding sysctls, UFW/nftables state, rootless Docker state, and representative hosted-site health. Verify a real external handshake, VPN egress IP and DNS, conditional IPv6, isolation from SSH/databases/private listeners/Docker networks/other peers, rotation, revocation, service restart, reboot persistence, and unchanged public websites. Then uninstall and verify that only marker-owned `pnlwg0` resources disappeared and that hosted services remain healthy. This cannot be proven by the application build or broker self-test; keep provider-console recovery available for the live networking pass.

Stopping the gateway disables its boot-start unit and interrupts clients without stopping Panelavo or hosted websites. Starting or restarting reuses the immutable installed endpoint, port, tunnel ranges, and DNS. To change those settings, uninstall and reinstall; all old client profiles are revoked. Uninstall removes the Panelavo service, sysctl file, tagged UFW rules, dedicated nftables tables, root-only state, and keys, while leaving distribution packages and every unrelated WireGuard/firewall resource installed.

---

## Stop / Restart

```bash
pm2 stop panelavo       # stop but keep it in the list
pm2 restart panelavo    # hard restart (brief downtime)
pm2 reload panelavo     # graceful reload (zero-downtime where possible)
pm2 delete panelavo     # remove from PM2 entirely
```

> After stopping, run `pm2 save` so the stopped/removed state is remembered
> across reboots.

---

## Deploy an update

From the application directory:

```bash
git pull
pnpm install --frozen-lockfile   # if dependencies changed
pnpm build
pm2 reload panelavo
pm2 save
```

User sessions survive restarts and can be reviewed or revoked from Profile — they are persisted to
`.data/sessions.json` (encrypted-at-rest material lives in `.data/`, which is
git-ignored and created with `0700`/`0600` permissions).

---

## Logs

```bash
pm2 logs panelavo                 # live tail (stdout + stderr)
pm2 logs panelavo --lines 200     # last 200 lines
pm2 logs panelavo --err           # errors only
pm2 flush panelavo                # truncate the log files
```

Raw log file locations:

```bash
pm2 describe panelavo | grep -E "log path|out log|error log"
# default: ~/.pm2/logs/panelavo-out.log and ~/.pm2/logs/panelavo-error.log
```

Application audit events (logins, mutations) are emitted as JSON on stdout, so
they land in the PM2 out log. Sensitive fields (passwords, tokens, cookies) are
redacted before logging. The same redacted events are retained in the bounded,
hash-chained `.data/audit` ledger and are available to Super Admins from the
Audit page. Its integrity badge verifies retained hashes, links, and the ledger
head; a failed badge should be investigated before trusting the displayed trail.

**Log rotation** (recommended so logs don't grow unbounded):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

---

## Health & monitoring

```bash
pm2 status              # process table (status, restarts, CPU, memory)
pm2 describe panelavo   # full details incl. restart count & memory
pm2 monit               # live dashboard (CPU / memory per process)
```

- `max_memory_restart` is set to **1G** in `ecosystem.config.js`: if the
  process ever exceeds that RSS, PM2 restarts it automatically instead of
  letting the host OOM. Tune it there for your box.
- A climbing **restart count** (`↺` column in `pm2 status`) means the process
  is crash-looping — check `pm2 logs panelavo --err`.

---

## Quick reference

| Action           | Command                         |
| ---------------- | ------------------------------- |
| Build            | `pnpm build`                    |
| Start            | `pm2 start ecosystem.config.js` |
| Stop             | `pm2 stop panelavo`             |
| Restart          | `pm2 restart panelavo`          |
| Graceful reload  | `pm2 reload panelavo`           |
| Status           | `pm2 status`                    |
| Live logs        | `pm2 logs panelavo`             |
| Persist for boot | `pm2 save` + `pm2 startup`      |
