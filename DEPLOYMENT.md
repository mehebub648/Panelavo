# Deployment & Operations (PM2)

panelavo runs as a **production** Next.js server managed by
[PM2](https://pm2.keymetrics.io/). Process name: **`panelavo`** — private
listener **`127.0.0.1:10443`**, proxied only through the HTTPS CloudPanel vhost.

On a fresh server, `sudo bash setup.sh` does everything below automatically
(CloudPanel install, site creation, build, PM2, boot persistence). This
document is for manual operation and updates afterwards. Run all commands as
the panel's site user from the application directory
(`/home/<site-user>/htdocs/<panel-domain>`).

---

## Prerequisites (one time)

1. **Node / pnpm on PATH.** PM2's daemon uses a minimal environment, so
   `ecosystem.config.js` calls Next's binary directly and does not need pnpm.
   You only need pnpm for `install` / `build`. Node.js releases do not always
   bundle Corepack, so the portable command is:

   ```bash
   npx -y pnpm@10.12.1 --version
   ```

2. **Environment.** Copy `.env.example` to `.env.local` and fill it in
   (setup.sh generates one automatically). For production make sure:

   | Variable                     | Notes                                                               |
   | ---------------------------- | ------------------------------------------------------------------- |
   | `SESSION_SECRET`             | **≥ 32 chars.** Required in production or the app refuses to start. |
   | `CREDENTIALS_ENCRYPTION_KEY` | Separate ≥ 32-char secret for encrypting Cloudflare tokens.         |

   All host-specific values are detected dynamically — you do **not** need to
   set `APP_BASE_URL` or `SERVER_PUBLIC_IP`:

   - The CSRF origin check compares the request `Origin` against the HTTP
     `Host` preserved by Nginx. It deliberately does not trust a supplied
     `X-Forwarded-Host` value.
   - The server's public IP for DNS "pointed" checks is auto-detected
     (`SERVER_PUBLIC_IP` still works as an optional override).
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

The file manager accepts files up to 64 MiB. Run `sudo bash setup.sh` after upgrading so the panel vhost receives its required `client_max_body_size 96m` directive. Setup validates Nginx and restores the previous vhost if validation fails.

Super Admins can perform normal application updates from Settings. The updater clones the configured public repository, verifies that the release's declared root-broker protocol is already installed and healthy, builds in staging, then preserves `.data` and `.env.local` while deploying and reloading only the Panelavo PM2 process. It never runs `setup.sh` or a root migration. Before the first update from 0.1.36 or older, run `sudo bash setup.sh` from a trusted checkout once; later incompatible broker releases are blocked before deployment with the same instruction. A successful trusted setup reconciles the persisted updater state to the version and commit it installed, clearing any stale failed-update marker without replacing the configured repository.

## Managed website Operations

The Operations tab manages applications hosted by CloudPanel; it is separate from updating Panelavo itself. CloudPanel's [configured site type](https://www.cloudpanel.io/docs/v2/frontend-area/add-site/), application root, runtime, document root, app port, and reverse-proxy upstream remain authoritative. Panelavo inspects only that application root and reports architecture evidence separately from runtime/tool availability, permission, configuration validity, and safety checks. It does not recursively search a repository for deployable apps.

`setup.sh` installs the host ACL, uidmap, D-Bus user-session, and slirp4netns prerequisites used by the root-owned broker. ACL enforcement stays under `/home/<site-user>/htdocs`, grants the site user named `rwX`, and applies default directory entries for future descendants. Existing installations must run the trusted `setup.sh` once when upgrading to broker protocol 3; the ordinary in-panel updater intentionally cannot install host packages or replace the root-owned broker.

The root contracts currently cover npm, pnpm, Yarn, and Bun projects; Composer, Laravel, and WordPress; uv, Poetry, Pipenv, pip virtual environments, and Django; direct static roots; reverse-proxy checks; PM2; and Docker Compose. A workspace needs usable root scripts or explicit root-level configuration. For a generated static site, configure CloudPanel to serve a verified build directory yourself: Panelavo does not infer `dist`, `build`, `out`, or another output and does not change the document root.

Every Operations request sends a validated action, plan, or fix identifier to the server. The server chooses the executable and arguments, fixes the working directory, runs without a shell, bounds runtime and output, and holds a per-site lock. Recommended plans execute synchronously, stop after the first failed step, and expose each step's result. A missing executable, ambiguous dependency manager, invalid configuration, insufficient role, or failed safety rule remains a visible blocker; Operations never installs a missing tool silently or as a fallback.

Some blocked preflight checks additionally offer an explicit one-click fix. Host-software fixes are Super Admin-only, individually confirmed, and serialized host-wide. Docker initialization verifies or installs Engine/CLI, Compose v2, Buildx, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, and `slirp4netns`, then configures linger and the site's systemd user daemon; Docker packages come from the official APT repository. Composer comes from getcomposer.org with installer signature verification.

Every Node.js, Python, reverse-proxy, or Compose application is checked against CloudPanel's configured upstream/app port. For a site whose configured port is `24001`, success means an HTTP service responds on `127.0.0.1:24001`; a process listening only on `3000` is reported as a mismatch and cannot produce a successful deployment result. Node/Python PM2 starts receive the expected port and loopback host environment, and plans verify the endpoint after startup.

For Compose, Panelavo determines the public entry service from an existing exact mapping, an explicit `io.panelavo.entrypoint=true` label, a unique candidate, the service dependency graph, or an unambiguous conventional gateway name. It determines the container port from an explicit `io.panelavo.container-port=<port>` label or consistent Compose port, environment, and health-check evidence. A safe mismatch such as frontend `127.0.0.1:3000:3000` for CloudPanel port `24001` is run as `127.0.0.1:24001:3000` through an ephemeral resolved Compose configuration. The source file is not modified. Other published service ports are forced to loopback and listed as additional endpoints; create connected reverse-proxy sites when those endpoints also need public domains. If entry service or container port is ambiguous, deployment blocks and shows the labels needed instead of guessing.

The lifecycle actions intentionally distinguish **Start services** (`docker compose up -d --remove-orphans`) from **Build & start services** (`docker compose up -d --build --remove-orphans`). Use the build operation after changing a Dockerfile, build context, build arguments, or dependencies copied into an image. Both start paths verify the configured website entry port before reporting success.

### Docker Compose prerequisite and policy

Docker is optional and is never installed automatically during preflight or by `setup.sh`. A Super Admin can run the explicit rootless initialization fix, which installs missing Docker packages from the official repository and validates cgroup v2/systemd, at least 65,536 non-overlapping subordinate UIDs/GIDs, functional `newuidmap`/`newgidmap`, the user manager and D-Bus, native rootless overlay storage (`overlay2` or Docker 29's `overlayfs`, with `fuse-overlayfs` guidance only when the native probe fails), linger, and the private socket. Ports below 1024 are unsupported.

```bash
docker context use rootless
docker compose version
docker info --format '{{json .SecurityOptions}}'
```

Do not add the Panelavo or website user to the `docker` group. Each site user owns a daemon at `/run/user/<uid>/docker.sock` and state under `/home/<site-user>/.local/share/docker`; no Docker API is exposed over TCP and Panelavo never falls back to `/var/run/docker.sock`. The setup-created rootless context is used for SSH, without exporting `DOCKER_HOST` in `.profile`. Ordinary Compose actions are permitted to site-write users because they grant nothing beyond that user's SSH access; host initialization and migration remain Super Admin-only.

For every Compose action, Panelavo supplies the selected root Compose file, stable project name, and exact site-user socket. Preflight requires the private daemon, a valid configuration, an unambiguous entry-port contract, and the safety policy. Runtime port remapping uses a site-owned mode-0600 file in a mode-0700 `/run/user/<uid>` directory and always deletes it. Privileged features, added capabilities, devices, host/shared namespaces, unsafe security options, and out-of-root bind mounts/build contexts block. Userspace forwarding can change the peer IP visible inside containers; trust CloudPanel's configured forwarded headers rather than authorize by that immediate address.

Legacy rootful projects use **Prepare** and **Cut over**. Prepare handles one service pull/build per request while traffic remains online; requests stop at 900 seconds, after which a longer build must be completed through the site's rootless SSH context and readiness refreshed. It rejects named/external volumes, unsupported features, out-of-root paths, conflicting bind users, and ambiguous numeric owners. Cutover revalidates the expiring manifest, stops but retains rootful containers, journals ownership, maps root to the site account and non-root container IDs into its subordinate range, reapplies site-user ACLs, starts with `--no-build`, and verifies state, health, ports, access, and HTTP. Failure restores ownership/ACLs and the rootful endpoint. Never delete an incomplete recovery journal manually.

Rootless image layers are duplicated per user and readiness reports store size, reclaimable data, and free filesystem space. The backup archive is limited to the configured `htdocs` application root and does not include `~/.local/share/docker`. Site deletion must remove the user's rootless objects and migration state, stop/disable Docker, remove its data, disable linger, and verify the socket is gone before deleting the CloudPanel site/Unix user.

### Failure and rollback limits

Managed dependency installs and builds operate on the configured live application root. Operations currently has no release-directory staging, atomic symlink switch, or automatic code rollback. Requests and child commands are synchronous and bounded; if a plan fails, earlier successful steps remain applied and later steps are skipped.

Laravel and Django migrations are deliberately excluded from recommended deployment plans and remain separately confirmed destructive actions. Panelavo does not create a database backup or guarantee a down migration. Export the relevant database and verify its restore procedure before running a migration. Static output selection and reverse-proxy cutover also remain explicit operator responsibilities.

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

User sessions survive restarts — they are persisted to
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
redacted before logging.

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
