# Panelavo project instructions

Panelavo is a Next.js 15 companion UI for a local CloudPanel installation. CloudPanel remains the source of truth; do not add a parallel user database or scrape its web portal.

## Important paths

- `src/app`: pages and API routes.
- `src/server/cloudpanel`: version-isolated CloudPanel CLI and bridge adapter.
- `src/server/auth`: authentication, authorization, and sessions.
- `src/server/updates` and `scripts/self-update.sh`: staged, non-root panel updates.
- `scripts/cloudpanel-bridge.php`: read-only Symfony bridge.
- `setup.sh`: root provisioning for supported Debian/Ubuntu servers.
- `.data`: runtime state and secrets; never commit or delete during deployment.

## Workflow

Use pnpm 10.12.1. Run targeted tests, then `npx pnpm@10.12.1 typecheck`, `lint`, and `build` when the affected surface warrants them. Validate installer edits with `bash -n setup.sh`; test firewall changes only with console recovery access available.

Keep CloudPanel commands argument-array based and validated. Never expose credentials or grant unrestricted sudo. The app runs as one PM2 process on port 10443 because its session model is not horizontally scalable.

The canonical version is in `package.json`. Each logical change increments it and adds a new `changelog/v<old>-<new>-changelog.md`. Keep `README.md`, `DEPLOYMENT.md`, and `ARCHITECTURE.md` synchronized with behavior.

Self-updates must run as the panel site user, preserve `.data` and `.env.local`, build successfully before deployment, and reload only the `panelavo` PM2 process. Do not give a configurable update repository root privileges.
