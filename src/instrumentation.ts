export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [backups, monitoring, gateway, storage, fleet] = await Promise.all([
      import("@/server/backups/scheduler"),
      import("@/server/monitoring/scheduler"),
      import("@/server/system/database-gateway-scheduler"),
      import("@/server/system/storage-hygiene"),
      import("@/server/fleet/scheduler"),
    ]);
    backups.ensureBackupScheduler();
    monitoring.ensureMonitoringScheduler();
    gateway.ensureDatabaseGatewayScheduler();
    storage.ensureStorageHygieneScheduler();
    fleet.ensureFleetScheduler();
  }
}
