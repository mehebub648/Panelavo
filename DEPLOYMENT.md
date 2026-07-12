# Deployment & Operations (PM2)

panelavo runs as a **production** Next.js server managed by
[PM2](https://pm2.keymetrics.io/). Process name: **`panelavo`** — port
**`10443`**.

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

   - The CSRF origin check compares the request `Origin` against the host the
     request arrived on (`X-Forwarded-Host` behind the proxy), so the panel
     works on any domain or IP without configuration.
   - The server's public IP for DNS "pointed" checks is auto-detected
     (`SERVER_PUBLIC_IP` still works as an optional override).
   - The session cookie's `Secure` flag follows the actual request scheme
     (`X-Forwarded-Proto`), so login works over both `https://<domain>` and a
     direct `http://<ip>:10443` connection.
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

The panel is now reachable on `https://<panel-domain>` (proxied to `:10443`).

The file manager accepts files up to 64 MiB. Run `sudo bash setup.sh` after upgrading so the panel vhost receives its required `client_max_body_size 96m` directive. Setup validates Nginx and restores the previous vhost if validation fails.

Super Admins can perform normal application updates from Settings. The updater clones and builds the configured public repository in staging, then preserves `.data` and `.env.local` while deploying and reloading only the Panelavo PM2 process. It does not run `setup.sh` or any root-level migration. When a changelog calls for host maintenance, run that step separately over SSH.

## Managed website Operations

The Operations tab manages applications hosted by CloudPanel; it is separate from updating Panelavo itself. CloudPanel's [configured site type](https://www.cloudpanel.io/docs/v2/frontend-area/add-site/), application root, runtime, document root, app port, and reverse-proxy upstream remain authoritative. Panelavo inspects only that application root and reports architecture evidence separately from runtime/tool availability, permission, configuration validity, and safety checks. It does not recursively search a repository for deployable apps.

The root contracts currently cover npm, pnpm, Yarn, and Bun projects; Composer, Laravel, and WordPress; uv, Poetry, Pipenv, pip virtual environments, and Django; direct static roots; reverse-proxy checks; PM2; and Docker Compose. A workspace needs usable root scripts or explicit root-level configuration. For a generated static site, configure CloudPanel to serve a verified build directory yourself: Panelavo does not infer `dist`, `build`, `out`, or another output and does not change the document root.

Every Operations request sends a validated action, plan, or fix identifier to the server. The server chooses the executable and arguments, fixes the working directory, runs without a shell, bounds runtime and output, and holds a per-site lock. Recommended plans execute synchronously, stop after the first failed step, and expose each step's result. A missing executable, ambiguous dependency manager, invalid configuration, insufficient role, or failed safety rule remains a visible blocker; Operations never installs a missing tool silently or as a fallback.

Some blocked preflight checks additionally offer an explicit one-click fix. Host-software fixes are Super Admin-only, individually confirmed, serialized host-wide, and always install the latest supported release from the official upstream source rather than a potentially outdated distribution package: Docker Engine and the Compose v2 plugin come from Docker's official APT repository (Debian/Ubuntu), the daemon start uses systemd, and Composer comes from getcomposer.org with installer signature verification.

Every Node.js, Python, reverse-proxy, or Compose application is checked against CloudPanel's configured upstream/app port. For a site whose configured port is `24001`, success means an HTTP service responds on `127.0.0.1:24001`; a process listening only on `3000` is reported as a mismatch and cannot produce a successful deployment result. Node/Python PM2 starts receive the expected port and loopback host environment, and plans verify the endpoint after startup.

For Compose, Panelavo determines the public entry service from an existing exact mapping, an explicit `io.panelavo.entrypoint=true` label, a unique candidate, the service dependency graph, or an unambiguous conventional gateway name. It determines the container port from an explicit `io.panelavo.container-port=<port>` label or consistent Compose port, environment, and health-check evidence. A safe mismatch such as frontend `127.0.0.1:3000:3000` for CloudPanel port `24001` is run as `127.0.0.1:24001:3000` through an ephemeral resolved Compose configuration. The source file is not modified. Other published service ports are forced to loopback and listed as additional endpoints; create connected reverse-proxy sites when those endpoints also need public domains. If entry service or container port is ambiguous, deployment blocks and shows the labels needed instead of guessing.

The lifecycle actions intentionally distinguish **Start services** (`docker compose up -d --remove-orphans`) from **Build & start services** (`docker compose up -d --build --remove-orphans`). Use the build operation after changing a Dockerfile, build context, build arguments, or dependencies copied into an image. Both start paths verify the configured website entry port before reporting success.

### Docker Compose prerequisite and policy

Docker is optional and is never installed automatically or by `setup.sh`. A Super Admin can either use the explicit "Install Docker Engine" fix on the Operations preflight (which configures Docker's official APT repository and installs the latest Engine, CLI, Buildx, and Compose v2 plugin) or provision Docker separately using Docker's [official installation instructions](https://docs.docker.com/engine/install/), then verify the host as an administrator:

```bash
docker compose version
docker info
```

Do not add the Panelavo or website user to the `docker` group. Docker documents that membership grants [root-level privileges](https://docs.docker.com/engine/install/linux-postinstall/); Panelavo instead keeps rootful Compose execution behind its allow-listed local bridge and restricts it to Super Admins.

For every rootful Compose action, Panelavo supplies the selected root Compose file and stable project name explicitly. Preflight requires the Docker CLI, Compose v2 plugin, reachable daemon, a successfully resolved configuration, an unambiguous entry-port contract, and a passing host-safety policy. Runtime port remapping uses a mode-0600 temporary resolved configuration that removes Compose-generated null or empty network IPAM placeholders, preserves configured IPAM mappings, and is deleted after execution. Deployment then probes the expected loopback port. A Compose manifest may therefore be detected while every action remains disabled; fix the reported host, configuration, or port blocker and refresh preflight rather than bypassing it with a generic root shell.

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
