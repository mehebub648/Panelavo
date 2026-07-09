# Deployment & Operations (PM2)

The Server Panel runs as a **production** Next.js server managed by [PM2](https://pm2.keymetrics.io/).
Process name: **`server-panel`** — port **`10443`**.

> Historically this app ran `next dev` under systemd. Production mode uses a
> fraction of the memory and removes the hot-reload machinery that was involved
> in the earlier out-of-memory incident.

---

## Prerequisites (one time)

1. **Node / pnpm on PATH.** PM2's daemon uses a minimal environment, so the
   `ecosystem.config.js` calls Next's binary directly and does not need pnpm.
   You only need pnpm for `build` / `install`. If `pnpm` is missing from your
   shell, enable it via Corepack:

   ```bash
   corepack enable && corepack prepare pnpm@10.12.1 --activate
   ```

2. **Environment.** Copy and fill `.env.local` (already present on this host).
   For production make sure:

   | Variable                    | Notes                                                        |
   | --------------------------- | ------------------------------------------------------------ |
   | `SESSION_SECRET`            | **≥ 32 chars.** Required in production or the app refuses to start. |
   | `CREDENTIALS_ENCRYPTION_KEY`| Separate ≥ 32-char secret for encrypting Cloudflare tokens.  |
   | `CLOUDPANEL_MODE`           | `live` to talk to the real CloudPanel CLI (`mock` = fake data). |

   All host-specific values are now detected dynamically — you do **not** need
   to set `APP_BASE_URL` or `SERVER_PUBLIC_IP`:
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

3. **Retire the old systemd dev unit** (if it was ever enabled) so it doesn't
   fight PM2 for port 10443:

   ```bash
   sudo systemctl disable --now server-panel-dev
   ```

---

## Build

A production build is required before (re)starting. Run it after every code change:

```bash
cd /home/clp-pro/htdocs/panel.152.239.123.12.mehebub.com
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

The panel is now reachable on `https://<your-domain>` (proxied to `:10443`).

---

## Stop / Restart

```bash
pm2 stop server-panel       # stop but keep it in the list
pm2 restart server-panel    # hard restart (brief downtime)
pm2 reload server-panel     # graceful reload (zero-downtime where possible)
pm2 delete server-panel     # remove from PM2 entirely
```

> After stopping, run `pm2 save` so the stopped/removed state is remembered
> across reboots.

---

## Deploy an update

```bash
cd /home/clp-pro/htdocs/panel.152.239.123.12.mehebub.com
git pull
pnpm install --frozen-lockfile   # if dependencies changed
pnpm build
pm2 reload server-panel
pm2 save
```

User sessions survive restarts — they are persisted to
`.data/sessions.json` (encrypted-at-rest material lives in `.data/`, which is
git-ignored and created with `0700`/`0600` permissions).

---

## Logs

```bash
pm2 logs server-panel                 # live tail (stdout + stderr)
pm2 logs server-panel --lines 200     # last 200 lines
pm2 logs server-panel --err           # errors only
pm2 flush server-panel                # truncate the log files
```

Raw log file locations:

```bash
pm2 describe server-panel | grep -E "log path|out log|error log"
# default: ~/.pm2/logs/server-panel-out.log and ~/.pm2/logs/server-panel-error.log
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
pm2 status                 # process table (status, restarts, CPU, memory)
pm2 describe server-panel  # full details incl. restart count & memory
pm2 monit                  # live dashboard (CPU / memory per process)
```

- `max_memory_restart` is set to **1G** in `ecosystem.config.js`: if the process
  ever exceeds that RSS, PM2 restarts it automatically instead of letting the
  host OOM. Tune it there for your box.
- A climbing **restart count** (`↺` column in `pm2 status`) means the process is
  crash-looping — check `pm2 logs server-panel --err`.

---

## Quick reference

| Action            | Command                              |
| ----------------- | ------------------------------------ |
| Build             | `pnpm build`                         |
| Start             | `pm2 start ecosystem.config.js`      |
| Stop              | `pm2 stop server-panel`              |
| Restart           | `pm2 restart server-panel`           |
| Graceful reload   | `pm2 reload server-panel`            |
| Status            | `pm2 status`                         |
| Live logs         | `pm2 logs server-panel`              |
| Persist for boot  | `pm2 save` + `pm2 startup`           |
