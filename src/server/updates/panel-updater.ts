import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isIP } from "node:net";
import { AppError } from "@/server/cloudpanel/errors";
import { getPanelSettings } from "@/server/settings/store";

export const UPDATE_BRANCH = "main";
const dataDir = () => process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const stateFile = () => join(dataDir(), "update-state.json");

export type UpdateState = {
  status: "idle" | "checking" | "available" | "current" | "queued" | "updating" | "failed" | "complete";
  currentVersion: string;
  repository: string;
  branch: string;
  installedCommit?: string;
  remoteCommit?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  logFile: string;
};

export function validateUpdateRepository(value: string) {
  const repository = value.trim();
  let parsed: URL;
  try { parsed = new URL(repository); } catch { throw new AppError("INVALID_REQUEST", "Enter a public HTTPS Git repository ending in .git.", 400); }
  if (repository.length > 500 || /\s/.test(repository) || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith(".git") || !parsed.hostname.includes(".") || isIP(parsed.hostname) !== 0 || parsed.hostname.endsWith(".local"))
    throw new AppError("INVALID_REQUEST", "Enter a public HTTPS Git repository ending in .git.", 400);
  return repository;
}

async function currentVersion() {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
  return pkg.version || "unknown";
}

async function loadState(): Promise<Partial<UpdateState>> {
  try { return JSON.parse(await readFile(stateFile(), "utf8")) as Partial<UpdateState>; } catch { return {}; }
}

async function saveState(state: UpdateState) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, stateFile());
}

function gitRemoteCommit(repository: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["ls-remote", repository, `refs/heads/${UPDATE_BRANCH}`], { shell: false });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 10000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 10000) stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const commit = stdout.trim().split(/\s+/)[0];
      if (code === 0 && /^[a-f0-9]{40}$/.test(commit)) resolve(commit);
      else reject(new Error(stderr.trim() || "The update repository could not be read."));
    });
  });
}

export async function getUpdateState(checkRemote = false): Promise<UpdateState> {
  const settings = await getPanelSettings();
  const repository = validateUpdateRepository(settings.updateRepository);
  const stored = await loadState();
  const base: UpdateState = {
    status: stored.status || "idle", currentVersion: await currentVersion(), repository,
    branch: UPDATE_BRANCH, installedCommit: stored.installedCommit,
    remoteCommit: stored.remoteCommit, startedAt: stored.startedAt,
    completedAt: stored.completedAt, error: stored.error,
    logFile: join(dataDir(), "update.log"),
  };
  if (!checkRemote || ["queued", "updating"].includes(base.status)) return base;
  try {
    const remoteCommit = await gitRemoteCommit(repository);
    const state = { ...base, remoteCommit, status: base.installedCommit === remoteCommit ? "current" : "available", error: undefined } as UpdateState;
    await saveState(state); return state;
  } catch {
    throw new AppError("CLOUDPANEL_UNAVAILABLE", "The update repository could not be reached.", 502);
  }
}

export async function queueUpdate() {
  const state = await getUpdateState(true);
  if (["queued", "updating"].includes(state.status))
    throw new AppError("INVALID_REQUEST", "An update is already running.", 409);
  const queued: UpdateState = { ...state, status: "queued", startedAt: new Date().toISOString(), completedAt: undefined, error: undefined };
  await saveState(queued);
  const child = spawn("/usr/bin/bash", [join(process.cwd(), "scripts", "self-update.sh"), state.repository, UPDATE_BRANCH, process.cwd()], {
    cwd: process.cwd(), detached: true, stdio: "ignore", shell: false,
  });
  child.on("error", () => undefined);
  child.unref();
  return queued;
}
