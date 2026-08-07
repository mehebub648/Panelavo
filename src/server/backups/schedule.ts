import { z } from "zod";
import { jsonStore } from "@/server/storage/json-store";

export const backupScheduleSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
    retention: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.frequency === "weekly" && value.weekday === undefined)
      context.addIssue({
        code: "custom",
        path: ["weekday"],
        message: "Choose a weekday for a weekly backup.",
      });
  });

export type BackupScheduleInput = z.infer<typeof backupScheduleSchema>;
export type BackupSchedule = BackupScheduleInput & {
  lastScheduledFor?: string;
  lastRunAt?: string;
  lastOutcome?: "success" | "failed" | "skipped";
  lastMessage?: string;
  lastBackupId?: string;
};

type Store = { sites: Record<string, BackupSchedule> };
const store = jsonStore<Store>(
  "backup-schedules.json",
  () => ({ sites: {} }),
  (value) => {
    const parsed = value as Partial<Store>;
    return {
      sites:
        parsed?.sites && typeof parsed.sites === "object" ? parsed.sites : {},
    };
  },
);

export const defaultBackupSchedule: BackupScheduleInput = {
  enabled: false,
  frequency: "daily",
  hour: 2,
  retention: 10,
};

export async function getBackupSchedule(domain: string): Promise<BackupSchedule> {
  return {
    ...defaultBackupSchedule,
    ...(await store.load()).sites[domain.toLowerCase()],
  };
}

export async function saveBackupSchedule(
  domain: string,
  input: BackupScheduleInput,
): Promise<BackupSchedule> {
  const value = await store.load();
  const key = domain.toLowerCase();
  value.sites[key] = { ...value.sites[key], ...input };
  await store.save(value);
  return value.sites[key];
}

export async function removeBackupSchedule(domain: string) {
  const value = await store.load();
  const key = domain.toLowerCase();
  if (!(key in value.sites)) return;
  delete value.sites[key];
  await store.save(value);
}

export function scheduledSlot(
  schedule: BackupSchedule,
  now: Date,
): string | null {
  if (!schedule.enabled || now.getUTCHours() !== schedule.hour) return null;
  if (
    schedule.frequency === "weekly" &&
    now.getUTCDay() !== schedule.weekday
  )
    return null;
  return schedule.frequency === "daily"
    ? now.toISOString().slice(0, 10)
    : `${now.toISOString().slice(0, 10)}-w${schedule.weekday}`;
}

export async function claimDueBackupSchedules(now = new Date()) {
  const value = await store.load();
  const claimed: Array<{ domain: string; schedule: BackupSchedule }> = [];
  for (const [domain, schedule] of Object.entries(value.sites)) {
    const slot = scheduledSlot(schedule, now);
    if (!slot || schedule.lastScheduledFor === slot) continue;
    schedule.lastScheduledFor = slot;
    schedule.lastRunAt = now.toISOString();
    delete schedule.lastMessage;
    claimed.push({ domain, schedule: { ...schedule } });
  }
  if (claimed.length) await store.save(value);
  return claimed;
}

export async function recordBackupScheduleOutcome(
  domain: string,
  outcome: Pick<
    BackupSchedule,
    "lastOutcome" | "lastMessage" | "lastBackupId"
  >,
) {
  const value = await store.load();
  const current = value.sites[domain.toLowerCase()];
  if (!current) return;
  Object.assign(current, outcome);
  await store.save(value);
}
