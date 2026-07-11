# Architecture

Panelavo is a single Next.js App Router application deployed as a CloudPanel Node.js site. Nginx/CloudPanel proxies the panel domain to the single PM2-managed Next.js process on port 10443.

Browser requests enter pages and route handlers in `src/app`. Shared validation lives in `src/schemas`; UI components live in `src/components`. Protected server routes obtain opaque application sessions from `src/server/auth`, revalidate current CloudPanel identity and roles, and call the live adapter in `src/server/cloudpanel`. The adapter invokes `/usr/bin/clpctl` for supported mutations and the read-only `scripts/cloudpanel-bridge.php` for Symfony/Doctrine data that the public CLI does not expose. CloudPanel remains authoritative for users, roles, MFA, sites, and assignments.

Application-owned metadata and encrypted credentials live under `.data` in the deployed site. Host configuration comes from `.env.local`; secrets must not reach client components. A single process is required by the current session and in-process rate-limit design.

`setup.sh` detects supported Debian/Ubuntu versions, installs prerequisites and CloudPanel when absent, publishes a complete non-root-readable Node.js distribution in `/usr/local/lib/panelavo-node`, and uses `npx` with the pinned pnpm version so Corepack is optional. It creates the panel site/user, deploys and builds the repository, configures narrow sudo access, starts PM2, and configures firewall/SSL. During provisioning it automatically pauses and subsequently restores fail2ban's `sshd` jail, with a configuration-reload fallback if a direct jail start fails. It recovers SSH connection metadata through process ancestry when sudo strips the environment, then preserves the actual live SSH port in UFW before firewall changes.
