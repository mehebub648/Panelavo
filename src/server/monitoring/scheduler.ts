import { connect } from "node:tls";
import { ensureResourceSampler } from "@/server/system/resource-history";
import { sendNotification } from "@/server/notifications/send";
import { getUpdateState } from "@/server/updates/panel-updater";
import { claimDueUptime, getUpdateMonitorState, saveUpdateMonitorState, updateSslState, updateUptimeState } from "./store";

const INTERVAL_MS = 60_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
type State = { timer?: NodeJS.Timeout; running: boolean };
const globals = globalThis as typeof globalThis & { __panelMonitoringScheduler?: State };
const state = (globals.__panelMonitoringScheduler ??= { running: false });

export async function probeSite(domain: string) {
  try {
    const response = await fetch(`https://${domain}/`, { method: "GET", redirect: "manual", headers: { "user-agent": "Panelavo-Uptime/1" }, signal: AbortSignal.timeout(12_000) });
    const up = response.status >= 200 && response.status < 400;
    return { up, statusCode: response.status, message: up ? undefined : `HTTP ${response.status}` };
  } catch (error) { return { up: false, message: error instanceof Error ? error.message.slice(0, 200) : "Request failed" }; }
}

export function certificateExpiry(domain: string): Promise<Date> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: true, timeout: 12_000 }, () => {
      const certificate = socket.getPeerCertificate(); socket.end();
      const expiry = new Date(certificate.valid_to);
      if (!certificate.valid_to || Number.isNaN(expiry.getTime())) reject(new Error("Certificate expiry was unavailable.")); else resolve(expiry);
    });
    socket.once("timeout", () => socket.destroy(new Error("TLS probe timed out.")));
    socket.once("error", reject);
  });
}

async function checkUptime() {
  for (const { domain, settings } of await claimDueUptime()) {
    const probe = await probeSite(domain);
    const result = await updateUptimeState(domain, (current) => {
      const failures = probe.up ? 0 : current.failures + 1;
      const down = !probe.up && failures >= settings.uptimeFailureSamples;
      const event = down && !current.alerted ? "down" : probe.up && current.alerted ? "recovery" : undefined;
      return { state: { ...current, status: probe.up ? "up" : down ? "down" : current.status, statusCode: probe.statusCode, message: probe.message, failures, alerted: down ? true : probe.up ? false : current.alerted }, event };
    });
    if (result.event) await sendNotification({ title: result.event === "down" ? `${domain} is down` : `${domain} recovered`, message: result.state.message || (result.event === "recovery" ? "The HTTPS check is succeeding again." : "The HTTPS check failed."), severity: result.event === "down" ? "critical" : "recovery", event: `uptime.${result.event}`, site: domain });
    if (settings.sslEnabled && (!result.state.sslCheckedAt || Date.now() - new Date(result.state.sslCheckedAt).getTime() >= UPDATE_INTERVAL_MS)) {
      try {
        const expiry = await certificateExpiry(domain); const days = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
        if (await updateSslState(domain, expiry.toISOString(), days < settings.sslDays)) await sendNotification({ title: `${domain} TLS certificate expires soon`, message: `The certificate expires in ${days} day${days === 1 ? "" : "s"} (${expiry.toISOString()}).`, severity: "warning", event: "ssl.expiring", site: domain });
      } catch { /* A failed HTTPS probe already covers unreachable TLS. */ }
    }
  }
}

async function checkUpdates() {
  const monitor = await getUpdateMonitorState();
  if (!monitor.settings.updatesEnabled || (monitor.state.lastCheckAt && Date.now() - new Date(monitor.state.lastCheckAt).getTime() < UPDATE_INTERVAL_MS)) return;
  const update = await getUpdateState(true);
  const available = update.remoteCommit && update.installedCommit !== update.remoteCommit;
  if (available && monitor.state.alertedCommit !== update.remoteCommit) await sendNotification({ title: "Panelavo update available", message: `A newer ${update.branch} commit is available from the configured repository.`, severity: "info", event: "panel.update.available" });
  await saveUpdateMonitorState({ lastCheckAt: new Date().toISOString(), alertedCommit: available ? update.remoteCommit : undefined });
}

export async function runMonitoringScheduler() {
  if (state.running) return; state.running = true;
  try { await checkUptime(); await checkUpdates().catch(() => undefined); }
  finally { state.running = false; }
}
export function ensureMonitoringScheduler() {
  void ensureResourceSampler();
  if (state.timer) return;
  state.timer = setInterval(() => void runMonitoringScheduler().catch(() => undefined), INTERVAL_MS); state.timer.unref?.();
  void runMonitoringScheduler().catch(() => undefined);
}
