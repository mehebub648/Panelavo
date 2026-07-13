# Panelavo project instructions

Panelavo is a Next.js 15 companion UI for a local CloudPanel installation. CloudPanel remains the source of truth; do not add a parallel user database or scrape its web portal.

## Important paths

- `src/app`: pages and API routes.
- `src/server/cloudpanel`: version-isolated CloudPanel CLI and bridge adapter.
- `src/server/sites/site-operations.ts`: Operations capability normalization, preflight policy, and server-owned plans.
- `src/server/auth`: authentication, authorization, and sessions.
- `src/server/updates` and `scripts/self-update.sh`: staged, non-root panel updates.
- `scripts/cloudpanel-bridge.php`: allow-listed local Symfony/Doctrine bridge for CloudPanel reads and narrowly mapped site-management actions.
- `setup.sh`: root provisioning for supported Debian/Ubuntu servers.
- `.data`: runtime state and secrets; never commit or delete during deployment.

## Workflow

Use pnpm 10.12.1. Run targeted tests, then `npx pnpm@10.12.1 typecheck`, `lint`, and `build` when the affected surface warrants them. Validate installer edits with `bash -n setup.sh`; test firewall changes only with console recovery access available.

Keep CloudPanel commands argument-array based and validated. Never expose credentials or grant unrestricted sudo. The app runs as one PM2 process bound to `127.0.0.1:10443`; only the CloudPanel/Nginx HTTPS vhost is public. `setup.sh` keeps that proxy's read/send timeout slightly above the 30-minute synchronous Operations and Backups request limit. The session and rate-limit model is not horizontally scalable.

CloudPanel's configured site type is authoritative for Operations. Detection, runtime/tool availability, permissions, manifest validation, and safety policy are separate preflight results; a manifest alone must never make an action runnable. Operations plans are server-owned, execute exact argument arrays without a shell, stay inside the configured site root, and take a per-site lock. Missing tools block visibly.

Docker sites use one rootless daemon per CloudPanel site user. Commands must run as that user against the exact `/run/user/<uid>/docker.sock`; never fall back to `/var/run/docker.sock`, expose an API over TCP, export `DOCKER_HOST` in the profile, or add Panelavo/site users to the `docker` group. Site-write users may run ordinary Compose lifecycle actions because this grants no capability beyond their own SSH session. Host package changes, rootless initialization, rootful migration/recovery, and destructive legacy cleanup are Super Admin-only, allow-listed, and serialized host-wide. The CloudPanel upstream/app port is mandatory. Use only the selected Compose file and stable project name after CLI, plugin, private-daemon, configuration, and safety checks. Ephemeral resolved files belong to the site user under `/run/user/<uid>` with private directory/file modes and must be deleted. Keep port normalization loopback-only; never auto-rewrite privileged mode, added capabilities, devices, host/shared namespaces, unsafe security options, or out-of-root mounts/build contexts. Userspace forwarding can change the immediate peer IP seen by a container, so applications must use CloudPanel's trusted forwarded headers rather than authorize by that peer address.

Rootful-to-rootless migration is explicitly two-phase. Preparation cold-pulls/builds one service per bounded request while the rootful project remains online, rejects named/external volumes and ambiguous ownership, and writes an expiring root-owned manifest. Cutover revalidates it, retains stopped rootful containers, journals numeric ownership, maps root to the site UID/GID and container id `n >= 1` to `subordinateStart + n - 1`, reapplies the site-user ACL invariant, starts with `--no-build`, and verifies health, ports, access, and HTTP. Failure must remove the partial rootless project, restore journaled and newly created ownership, reapply ACLs, and restart/verify rootful containers. Never discard a stale recovery journal silently. On site deletion, remove rootless objects and data, stop/disable the user service, disable linger and verify the socket is gone before CloudPanel removes the Unix user.

Backups are on-server, per-site snapshots (gzip tar of the app root + `clpctl db:export` per database) under `/home/<user>/backups/<id>/`. Keep creation atomic (delete the partial snapshot on any failure), keep them site-user-owned so the File Manager and SFTP can serve downloads, hold the per-site operations lock during heavy jobs, and be honest in copy and docs: on-server only (no off-site or scheduled backups yet), restore is an in-place overlay plus database import (not an exact point-in-time replacement), and a database deleted since the backup is skipped on restore. Load the section only for site-write users.

The per-site Terminal and Environment manager operate strictly at the site-user boundary. Terminal commands are the one deliberate exception to "no browser-supplied commands": they run only as the unprivileged site user through a bounded, non-interactive login shell with a contained working directory — never as root and never beyond what that user's own SSH session could do. Environment values are secrets: load and render them only for users with site-write access, keep the Operations runtime payload limited to env key names and sync verdicts, sync `.env` to the managed `~/.profile` block without touching content outside the markers, and let CloudPanel's expected `PORT` win over any conflicting `.env` entry at launch.

The CloudPanel site user must retain recursive read/write/traverse access to its configured application root even when rootless containers create subuid-owned descendants. Enforce this with a named POSIX ACL for the site user plus default ACLs on every directory so future descendants inherit access, including after migration ownership translation or rollback. Do not solve ownership drift with world-writable modes, broad ownership replacement outside the journaled migration, Docker-group membership, or traversal outside `/home/<site-user>/htdocs`.

The canonical version is in `package.json`. Each logical change increments it and adds a new `changelog/v<old>-<new>-changelog.md`. Keep `README.md`, `DEPLOYMENT.md`, and `ARCHITECTURE.md` synchronized with behavior.

Self-updates must run as the panel site user, preserve `.data` and `.env.local`, build successfully before deployment, and reload only the `panelavo` PM2 process. Do not give a configurable update repository root privileges. Root-only broker upgrades are installed by `setup.sh`; the in-panel updater must refuse a release before deployment when its declared broker protocol is missing, unhealthy, or incompatible.
