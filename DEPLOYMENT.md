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
