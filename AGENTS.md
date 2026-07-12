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

Rootful Docker Compose actions are Super Admin-only and must use the explicitly selected Compose file and project name after CLI, Compose plugin, daemon, configuration, and host-safety checks. Never install Docker automatically or add Panelavo/site users to the `docker` group. The CloudPanel upstream/app port is the mandatory website entry port. Compose may select an entry service only from explicit labels, an existing exact mapping, a unique candidate, the dependency graph, or an unambiguous conventional gateway name. A safe mismatch is corrected only in an ephemeral resolved runtime configuration: map the selected container port to `127.0.0.1:<expected-port>`, force other published ports onto loopback, never edit the source Compose file, and delete the temporary configuration after execution. Ambiguous services or ports block with exact label guidance. Node/Python launches receive the expected port, and every port-based plan verifies that the expected loopback port responds before success. Report additional ports so operators can create connected reverse-proxy sites. Preflight host-software fixes (Docker Engine/Compose plugin from Docker's official APT repo, daemon start via systemd, Composer from getcomposer.org with signature verification) are Super Admin-only, allow-listed, serialized host-wide, and always install the latest upstream release. Never auto-rewrite violations needing operator judgement (privileged mode, host namespaces, out-of-root mounts) — instruct instead. Keep Operations execution synchronous and bounded; do not claim atomic releases, automatic database rollback, recursive workspace discovery, or a guessed static build output.

The per-site Terminal and Environment manager operate strictly at the site-user boundary. Terminal commands are the one deliberate exception to "no browser-supplied commands": they run only as the unprivileged site user through a bounded, non-interactive login shell with a contained working directory — never as root and never beyond what that user's own SSH session could do. Environment values are secrets: load and render them only for users with site-write access, keep the Operations runtime payload limited to env key names and sync verdicts, sync `.env` to the managed `~/.profile` block without touching content outside the markers, and let CloudPanel's expected `PORT` win over any conflicting `.env` entry at launch.

The canonical version is in `package.json`. Each logical change increments it and adds a new `changelog/v<old>-<new>-changelog.md`. Keep `README.md`, `DEPLOYMENT.md`, and `ARCHITECTURE.md` synchronized with behavior.

Self-updates must run as the panel site user, preserve `.data` and `.env.local`, build successfully before deployment, and reload only the `panelavo` PM2 process. Do not give a configurable update repository root privileges.
