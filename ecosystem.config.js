/**
 * PM2 process definition for panelavo (Next.js, production mode).
 *
 * Prerequisites: run a production build first (`pnpm build`), then:
 *   pm2 start ecosystem.config.js
 *
 * See DEPLOYMENT.md for the full run / stop / logs / update workflow.
 */
const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "panelavo",
      cwd: __dirname,
      // Invoke Next's binary directly so we don't depend on pnpm being on PATH
      // (pm2's daemon runs with a minimal environment).
      script: join(__dirname, "node_modules", "next", "dist", "bin", "next"),
      args: "start -p 10443",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,

      // Resilience + a safety net against the memory-exhaustion class of
      // incident: pm2 restarts the process if RSS crosses the threshold.
      autorestart: true,
      max_memory_restart: "1G",
      max_restarts: 10,
      min_uptime: "20s",
      restart_delay: 3000,
      kill_timeout: 10000,

      // Timestamped, merged logs (view with `pm2 logs panelavo`).
      time: true,
      merge_logs: true,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
