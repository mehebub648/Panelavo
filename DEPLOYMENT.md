# Deployment & Operations (PM2)

panelavo runs as a production Next.js server managed by [PM2](https://pm2.keymetrics.io/).
Process name: **`panelavo`**. Default port: **`10443`**.

For new servers, prefer the installer:

```bash
sudo bash setup.sh
```

The manual notes below are for existing installs or local maintenance.

## Prerequisites

1. **Node / pnpm on PATH.** PM2's daemon uses a minimal environment, so `ecosystem.config.js` calls Next's binary directly and does not need pnpm. You only need pnpm for `build` and `install`. If `pnpm` is missing from your shell, enable it via Corepack:

   ```bash
   corepack enable && corepack prepare pnpm@10.12.1 --activate
   ```

2. **Environment.** Copy `.env.example` to `.env.local` and fill production secrets:

   | Variable                     | Notes                                                                       |
   | ---------------------------- | --------------------------------------------------------------------------- |
   | `SESSION_SECRET`             | At least 32 characters. Required in production or the app refuses to start. |
   | `CREDENTIALS_ENCRYPTION_KEY` | Separate 32+ character secret for encrypting Cloudflare tokens.             |

   Host-specific values are detected dynamically. You do not need to set `APP_BASE_URL` or `SERVER_PUBLIC_IP` unless you want to override auto-detection.

3. **Sudo access.** panelavo needs the app's Linux user to run `/usr/bin/clpctl` and `/usr/bin/php` through passwordless sudo. `setup.sh` installs this rule for the `panelavo` site user.

## Build

A production build is required before starting or reloading:

```bash
cd /home/<panel-site-user>/htdocs/<panelavo-domain>
pnpm install --frozen-lockfile
pnpm build
```

## Run

Start or restart under PM2 using the committed config:

```bash
pm2 start ecosystem.config.js
```

Persist the process list so it survives a reboot:

```bash
pm2 save
pm2 startup
```

panelavo is reachable on `https://<your-domain>` when proxied through CloudPanel, and directly at `http://<server-ip>:10443` unless your firewall blocks that port.

## Stop / Restart

```bash
pm2 stop panelavo
pm2 restart panelavo
pm2 reload panelavo
pm2 delete panelavo
```

After stopping or deleting, run `pm2 save` so the state is remembered across reboots.

## Deploy an update

```bash
cd /home/<panel-site-user>/htdocs/<panelavo-domain>
git pull
pnpm install --frozen-lockfile
pnpm build
pm2 reload panelavo
pm2 save
```

User sessions survive restarts. They are persisted to `.data/sessions.json`; encrypted-at-rest material lives in `.data/`, which is git-ignored and created with `0700`/`0600` permissions.

## Logs

```bash
pm2 logs panelavo
pm2 logs panelavo --lines 200
pm2 logs panelavo --err
pm2 flush panelavo
```

Raw log file locations:

```bash
pm2 describe panelavo | grep -E "log path|out log|error log"
# default: ~/.pm2/logs/panelavo-out.log and ~/.pm2/logs/panelavo-error.log
```

Application audit events are emitted as JSON on stdout, so they land in the PM2 out log. Sensitive fields such as passwords, tokens, cookies, and MFA codes are redacted before logging.

Log rotation is recommended:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## Health & monitoring

```bash
pm2 status
pm2 describe panelavo
pm2 monit
```

- `max_memory_restart` is set to `1G` in `ecosystem.config.js`.
- A climbing restart count in `pm2 status` means the process is crash-looping. Check `pm2 logs panelavo --err`.

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
