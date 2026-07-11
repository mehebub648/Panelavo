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

Keep CloudPanel commands argument-array based and validated. Never expose credentials or grant unrestricted sudo. The app runs as one PM2 process on port 10443 because its session model is not horizontally scalable.

CloudPanel's configured site type is authoritative for Operations. Detection, runtime/tool availability, permissions, manifest validation, and safety policy are separate preflight results; a manifest alone must never make an action runnable. Operations plans are server-owned, execute exact argument arrays without a shell, stay inside the configured site root, and take a per-site lock. Missing tools block visibly.

Rootful Docker Compose actions are Super Admin-only and must use the explicitly selected Compose file and project name after CLI, Compose plugin, daemon, configuration, and host-safety checks. Never install Docker automatically or add Panelavo/site users to the `docker` group. Preflight "fix" actions repair blocked checks: host-software fixes (Docker Engine/Compose plugin from Docker's official APT repo, daemon start via systemd, Composer from getcomposer.org with signature verification) are Super Admin-only, allow-listed, serialized host-wide, and always install the latest upstream release — never a possibly stale distribution package. Site-scoped fixes edit only files inside the site root and need ordinary Operations permission; the one supported today rewrites Compose published ports to bind `127.0.0.1` (same port numbers), validates with `docker compose config`, re-scans the safety policy, commits only a fully safe result, and backs up the original. Never auto-rewrite violations needing operator judgement (privileged mode, host namespaces, out-of-root mounts, exotic port syntax) — instruct instead. Every fix is individually confirmed and reports per-step results. Keep Operations execution synchronous and bounded; do not claim atomic releases, automatic database rollback, recursive workspace discovery, or a guessed static build output.

The canonical version is in `package.json`. Each logical change increments it and adds a new `changelog/v<old>-<new>-changelog.md`. Keep `README.md`, `DEPLOYMENT.md`, and `ARCHITECTURE.md` synchronized with behavior.

Self-updates must run as the panel site user, preserve `.data` and `.env.local`, build successfully before deployment, and reload only the `panelavo` PM2 process. Do not give a configurable update repository root privileges.
