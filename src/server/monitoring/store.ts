import { z } from "zod";
import { jsonStore } from "@/server/storage/json-store";

export const monitoringSettingsSchema = z.object({
  resources: z.object({ enabled: z.boolean(), cpu: z.number().min(1).max(100), memory: z.number().min(1).max(100), disk: z.number().min(1).max(100), consecutiveSamples: z.number().int().min(1).max(15) }).strict(),
  uptimeFailureSamples: z.number().int().min(1).max(10),
  sslEnabled: z.boolean(),
  sslDays: z.number().int().min(1).max(90),
  updatesEnabled: z.boolean(),
}).strict();

export const uptimeConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(60),
}).strict();

export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;
export type UptimeConfig = z.infer<typeof uptimeConfigSchema>;
export type UptimeState = { status: "unknown" | "up" | "down"; lastCheckAt?: string; statusCode?: number; message?: string; failures: number; alerted: boolean; sslCheckedAt?: string; sslExpiresAt?: string; sslAlertedExpiry?: string };
export type MetricState = { breaches: number; recoveries: number; active: boolean };
type Store = {
  settings: MonitoringSettings;
  sites: Record<string, UptimeConfig>;
  uptime: Record<string, UptimeState>;
  metrics: Record<"cpu" | "memory" | "disk", MetricState>;
  update?: { lastCheckAt?: string; alertedCommit?: string };
};

export const defaultMonitoringSettings: MonitoringSettings = {
  resources: { enabled: true, cpu: 90, memory: 90, disk: 75, consecutiveSamples: 3 },
  uptimeFailureSamples: 2,
  sslEnabled: true,
  sslDays: 14,
  updatesEnabled: true,
};
const metric = (): MetricState => ({ breaches: 0, recoveries: 0, active: false });
const fallback = (): Store => ({ settings: defaultMonitoringSettings, sites: {}, uptime: {}, metrics: { cpu: metric(), memory: metric(), disk: metric() } });
const store = jsonStore<Store>("monitoring.json", fallback, (value) => ({ ...fallback(), ...(value as Partial<Store>), settings: { ...defaultMonitoringSettings, ...(value as Partial<Store>)?.settings, resources: { ...defaultMonitoringSettings.resources, ...(value as Partial<Store>)?.settings?.resources } }, metrics: { ...fallback().metrics, ...(value as Partial<Store>)?.metrics } }));
let queue: Promise<unknown> = Promise.resolve();
async function mutate<T>(fn: (value: Store) => T | Promise<T>): Promise<T> {
  const operation = queue.then(async () => { const value = await store.load(); const result = await fn(value); await store.save(value); return result; });
  queue = operation.catch(() => undefined);
  return operation;
}

export async function getMonitoringSettings() { return (await store.load()).settings; }
export async function saveMonitoringSettings(input: MonitoringSettings) { return mutate((value) => (value.settings = input)); }
export async function getUptime(domain: string) {
  const value = await store.load(); const key = domain.toLowerCase();
  return { config: value.sites[key] ?? { enabled: false, intervalMinutes: 5 }, state: value.uptime[key] ?? { status: "unknown", failures: 0, alerted: false } };
}
export async function saveUptime(domain: string, input: UptimeConfig) { return mutate((value) => { value.sites[domain.toLowerCase()] = input; return getUptimeFrom(value, domain); }); }
export async function removeUptime(domain: string) { return mutate((value) => { delete value.sites[domain.toLowerCase()]; delete value.uptime[domain.toLowerCase()]; }); }
function getUptimeFrom(value: Store, domain: string) { const key = domain.toLowerCase(); return { config: value.sites[key] ?? { enabled: false, intervalMinutes: 5 }, state: value.uptime[key] ?? { status: "unknown" as const, failures: 0, alerted: false } }; }
export async function getAllUptimeStates() { return (await store.load()).uptime; }
export async function claimDueUptime(now = Date.now()) { return mutate((value) => Object.entries(value.sites).filter(([, config]) => config.enabled).filter(([domain, config]) => { const state = value.uptime[domain]; const due = !state?.lastCheckAt || now - new Date(state.lastCheckAt).getTime() >= config.intervalMinutes * 60_000; if (due) { value.uptime[domain] = { ...(state ?? { status: "unknown", failures: 0, alerted: false }), lastCheckAt: new Date(now).toISOString() }; } return due; }).map(([domain, config]) => ({ domain, config, settings: value.settings }))); }
export async function updateUptimeState(domain: string, fn: (state: UptimeState, settings: MonitoringSettings) => { state: UptimeState; event?: "down" | "recovery" }) { return mutate((value) => { const key = domain.toLowerCase(); const result = fn(value.uptime[key] ?? { status: "unknown", failures: 0, alerted: false }, value.settings); value.uptime[key] = result.state; return result; }); }
export async function mutateMetric(name: "cpu" | "memory" | "disk", fn: (state: MetricState, settings: MonitoringSettings) => { state: MetricState; event?: "alert" | "recovery" }) { return mutate((value) => { const result = fn(value.metrics[name], value.settings); value.metrics[name] = result.state; return { ...result, settings: value.settings }; }); }
export async function updateSslState(domain: string, expiresAt: string, shouldAlert: boolean) { return mutate((value) => { const key = domain.toLowerCase(); const state = value.uptime[key] ?? { status: "unknown", failures: 0, alerted: false }; const alert = shouldAlert && state.sslAlertedExpiry !== expiresAt; value.uptime[key] = { ...state, sslCheckedAt: new Date().toISOString(), sslExpiresAt: expiresAt, ...(alert ? { sslAlertedExpiry: expiresAt } : {}) }; return alert; }); }
export async function getUpdateMonitorState() { const value = await store.load(); return { settings: value.settings, state: value.update ?? {} }; }
export async function saveUpdateMonitorState(input: { lastCheckAt?: string; alertedCommit?: string }) { return mutate((value) => (value.update = input)); }
