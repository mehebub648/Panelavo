import type { ResourceHistoryPoint } from "@/types/cloudpanel";
import { sendNotification } from "@/server/notifications/send";
import { mutateMetric, type MetricState } from "./store";

export function evaluateMetric(state: MetricState, value: number, threshold: number, required: number) {
  const next = { ...state };
  if (value >= threshold) { next.breaches += 1; next.recoveries = 0; if (!next.active && next.breaches >= required) { next.active = true; return { state: next, event: "alert" as const }; } }
  else { next.breaches = 0; next.recoveries += 1; if (next.active && next.recoveries >= required) { next.active = false; return { state: next, event: "recovery" as const }; } }
  return { state: next };
}

export async function evaluateResourceAlerts(point: ResourceHistoryPoint) {
  for (const [name, value, label] of [["cpu", point.cpu, "CPU"], ["memory", point.mem, "Memory"], ["disk", point.disk, "Disk"]] as const) {
    const result = await mutateMetric(name, (state, settings) => settings.resources.enabled ? evaluateMetric(state, value, settings.resources[name], settings.resources.consecutiveSamples) : { state: { breaches: 0, recoveries: 0, active: false } });
    if (!result.event) continue;
    await sendNotification({ title: result.event === "alert" ? `${label} threshold exceeded` : `${label} usage recovered`, message: `${label} usage is ${value}% (threshold ${result.settings.resources[name]}%).`, severity: result.event === "alert" ? "critical" : "recovery", event: `resources.${name}.${result.event}` });
  }
}
