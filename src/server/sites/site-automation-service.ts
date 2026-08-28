import {
  deleteOffsiteBackup,
  getOffsiteDestination,
  listOffsiteBackups,
  offsiteDestinationSchema,
  removeOffsiteDestination,
  restoreOffsiteBackup,
  saveOffsiteDestination,
  uploadOffsiteBackup,
} from "@/server/backups/offsite";
import {
  backupScheduleSchema,
  getBackupSchedule,
  saveBackupSchedule,
} from "@/server/backups/schedule";
import {
  deployHooksSchema,
  getDeployHooks,
  setDeployHooks,
} from "@/server/deploy/hooks";
import {
  getUptime,
  saveUptime,
  uptimeConfigSchema,
} from "@/server/monitoring/store";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleSiteForActor,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { manageSiteSectionForActor } from "@/server/sites/site-section-service";
import { assertDiskGrowthAllowed } from "@/server/system/storage-hygiene";

export async function getSiteUptimeForActor(actor: PanelActor, domain: string) {
  await accessibleSiteForActor(actor, domain);
  return getUptime(domain);
}

export async function saveSiteUptimeForActor(
  actor: PanelActor,
  domain: string,
  input: unknown,
) {
  await writableSiteForActor(actor, domain);
  return saveUptime(domain, uptimeConfigSchema.parse(input));
}

export async function getSiteDeployHooksForActor(
  actor: PanelActor,
  domain: string,
) {
  await writableSiteForActor(actor, domain);
  return getDeployHooks(domain);
}

export async function saveSiteDeployHooksForActor(
  actor: PanelActor,
  domain: string,
  input: unknown,
) {
  await writableSiteForActor(actor, domain);
  return setDeployHooks(domain, deployHooksSchema.parse(input));
}

export async function getSiteBackupAutomationForActor(
  actor: PanelActor,
  domain: string,
) {
  await writableSiteForActor(actor, domain);
  const [schedule, destination, offsiteBackups] = await Promise.all([
    getBackupSchedule(domain),
    getOffsiteDestination(domain),
    listOffsiteBackups(domain).catch(() => []),
  ]);
  return { schedule, destination, offsiteBackups };
}

export async function saveSiteBackupScheduleForActor(
  actor: PanelActor,
  domain: string,
  input: unknown,
) {
  await writableSiteForActor(actor, domain);
  return saveBackupSchedule(domain, backupScheduleSchema.parse(input));
}

export async function saveSiteOffsiteDestinationForActor(
  actor: PanelActor,
  domain: string,
  input: unknown,
) {
  await writableSiteForActor(actor, domain);
  const destination = await saveOffsiteDestination(
    domain,
    offsiteDestinationSchema.parse(input),
  );
  return { destination, offsiteBackups: await listOffsiteBackups(domain) };
}

export async function removeSiteOffsiteDestinationForActor(
  actor: PanelActor,
  domain: string,
) {
  await writableSiteForActor(actor, domain);
  await removeOffsiteDestination(domain);
  return { deleted: true };
}

export async function manageSiteOffsiteBackupForActor(
  actor: PanelActor,
  domain: string,
  action: "upload" | "restore" | "delete",
  id: string,
) {
  await writableSiteForActor(actor, domain);
  if (action === "upload" || action === "restore")
    await assertDiskGrowthAllowed();
  if (action === "upload") await uploadOffsiteBackup(domain, id);
  if (action === "delete") await deleteOffsiteBackup(domain, id);
  if (action === "restore") {
    await restoreOffsiteBackup(domain, id);
    await manageSiteSectionForActor(actor, domain, "backups", {
      action: "restore",
      id,
      scope: "all",
    });
  }
  return { offsiteBackups: await listOffsiteBackups(domain) };
}
