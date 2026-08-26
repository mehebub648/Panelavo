import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isIP } from "node:net";
import { AppError } from "@/server/cloudpanel/errors";
import { getPanelSettings } from "@/server/settings/store";

export const UPDATE_BRANCH = "main";
const BROKER_PATH = "/usr/local/libexec/panelavo/panelavo-broker";
const dataDir = () =>
  process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const stateFile = () => join(dataDir(), "update-state.json");

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "ahead"
  | "diverged"
  | "blocked"
  | "queued"
  | "updating"
  | "reloading"
  | "failed"
  | "complete";

export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  repository: string;
  branch: string;
  installedCommit?: string;
  remoteCommit?: string;
  remoteVersion?: string;
  installedBrokerProtocol?: number;
  requiredBrokerProtocol?: number;
  brokerState?: "healthy" | "mismatch" | "unavailable";
  notice?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  previousPid?: number;
  logFile: string;
};

type ReleaseMetadata = {
  commit: string;
  version: string;
  brokerProtocol: number;
};

type BrokerProbe = Pick<UpdateState, "installedBrokerProtocol" | "brokerState">;

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareReleaseVersions(installed: string, remote: string) {
  const installedMatch = stableVersionPattern.exec(installed);
  const remoteMatch = stableVersionPattern.exec(remote);
  if (!installedMatch || !remoteMatch) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const difference =
      Number(installedMatch[index]) - Number(remoteMatch[index]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function classifyUpdate(input: {
  currentVersion: string;
  installedCommit?: string;
  remoteVersion: string;
  remoteCommit: string;
  installedBrokerProtocol?: number;
  requiredBrokerProtocol: number;
  brokerState: NonNullable<UpdateState["brokerState"]>;
}): Pick<UpdateState, "status" | "notice"> {
  if (input.installedCommit === input.remoteCommit) {
    return {
      status: "current",
      notice:
        input.brokerState === "healthy"
          ? undefined
          : "Panelavo code is current, but the root-owned broker could not be verified. Run trusted setup.sh before using privileged features.",
    };
  }

  const comparison = compareReleaseVersions(
    input.currentVersion,
    input.remoteVersion,
  );
  if (comparison === undefined)
    return {
      status: "blocked",
      notice:
        "Panelavo could not safely compare the installed and repository release versions.",
    };
  if (comparison > 0)
    return {
      status: "ahead",
      notice: `This server runs v${input.currentVersion}, newer than update-channel v${input.remoteVersion}. Install latest will not downgrade it.`,
    };
  if (comparison === 0)
    return {
      status: "diverged",
      notice: `The installed and repository commits both declare v${input.currentVersion}. Publish the repository change with a higher version before updating.`,
    };

  if (
    input.brokerState !== "healthy" ||
    input.installedBrokerProtocol !== input.requiredBrokerProtocol
  ) {
    const installed = input.installedBrokerProtocol;
    return {
      status: "blocked",
      notice: installed
        ? `Release v${input.remoteVersion} requires broker protocol ${input.requiredBrokerProtocol}, but protocol ${installed} is installed. Run trusted sudo bash setup.sh for this release first.`
        : `Release v${input.remoteVersion} requires broker protocol ${input.requiredBrokerProtocol}, but the installed broker could not be verified. Run trusted sudo bash setup.sh for this release first.`,
    };
  }

  return { status: "available", notice: undefined };
}

export function isUpdateCurrent(
  state: Pick<UpdateState, "installedCommit" | "remoteCommit">,
) {
  return Boolean(
    state.installedCommit &&
    state.remoteCommit &&
    state.installedCommit === state.remoteCommit,
  );
}

export function shouldCompleteUpdateHandoff(
  state: Partial<UpdateState>,
  currentPid = process.pid,
) {
  if (state.status === "reloading")
    return Boolean(state.previousPid && state.previousPid !== currentPid);
  // Recovery for releases before 0.1.17, whose worker was killed by PM2
  // after recording the installed commit but before recording completion.
  return state.status === "updating" && isUpdateCurrent(state);
}

async function effectiveState() {
  const state = await loadState();
  if (!shouldCompleteUpdateHandoff(state)) return state;
  const complete = {
    ...state,
    status: "complete",
    completedAt: new Date().toISOString(),
    previousPid: undefined,
  } as Partial<UpdateState>;
  await saveStoredState(complete);
  await rm(join(dataDir(), "update.lock"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  return complete;
}

export async function isPanelUpdateRunning() {
  const state = await effectiveState();
  return (
    state.status === "queued" ||
    state.status === "updating" ||
    state.status === "reloading"
  );
}

export function validateUpdateRepository(value: string) {
  const repository = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    throw new AppError(
      "INVALID_REQUEST",
      "Enter a public HTTPS Git repository ending in .git.",
      400,
    );
  }
  if (
    repository.length > 500 ||
    /\s/.test(repository) ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.endsWith(".git") ||
    !parsed.hostname.includes(".") ||
    isIP(parsed.hostname) !== 0 ||
    parsed.hostname.endsWith(".local")
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Enter a public HTTPS Git repository ending in .git.",
      400,
    );
  return repository;
}

async function currentRelease() {
  const pkg = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as { version?: string; panelavo?: { brokerProtocolVersion?: number } };
  return {
    version: pkg.version || "unknown",
    brokerProtocol:
      Number.isInteger(pkg.panelavo?.brokerProtocolVersion) &&
      Number(pkg.panelavo?.brokerProtocolVersion) > 0
        ? Number(pkg.panelavo?.brokerProtocolVersion)
        : undefined,
  };
}

async function loadState(): Promise<Partial<UpdateState>> {
  try {
    return JSON.parse(
      await readFile(stateFile(), "utf8"),
    ) as Partial<UpdateState>;
  } catch {
    return {};
  }
}

async function saveStoredState(state: Partial<UpdateState>) {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, stateFile());
}

async function saveState(state: UpdateState) {
  await saveStoredState(state);
}

function runCommand(
  command: string,
  args: string[],
  options: { input?: string; timeout?: number; cwd?: string } = {},
) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString();
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout ?? 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function checkedCommand(
  command: string,
  args: string[],
  options?: { input?: string; timeout?: number; cwd?: string },
) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0 || result.timedOut)
    throw new Error(
      result.timedOut
        ? "The update repository check timed out."
        : result.stderr.trim() || "The update repository could not be read.",
    );
  return result.stdout;
}

async function gitRemoteRelease(repository: string): Promise<ReleaseMetadata> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dataDir(), "update-check."));
  try {
    await checkedCommand(
      "/usr/bin/git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--no-checkout",
        "--single-branch",
        "--branch",
        UPDATE_BRANCH,
        "--",
        repository,
        temporary,
      ],
      { timeout: 60_000 },
    );
    const commit = (
      await checkedCommand("/usr/bin/git", [
        "-C",
        temporary,
        "rev-parse",
        "HEAD",
      ])
    ).trim();
    const packageText = await checkedCommand(
      "/usr/bin/git",
      ["-C", temporary, "show", "HEAD:package.json"],
      { timeout: 30_000 },
    );
    const pkg = JSON.parse(packageText) as {
      name?: string;
      version?: string;
      panelavo?: { brokerProtocolVersion?: number };
    };
    if (
      !/^[a-f0-9]{40}$/.test(commit) ||
      pkg.name !== "panelavo" ||
      !pkg.version ||
      !stableVersionPattern.test(pkg.version) ||
      !Number.isInteger(pkg.panelavo?.brokerProtocolVersion) ||
      Number(pkg.panelavo?.brokerProtocolVersion) <= 0
    )
      throw new AppError(
        "INVALID_REQUEST",
        "The update repository does not contain a valid stable Panelavo release.",
        409,
      );
    const brokerProtocol = Number(pkg.panelavo?.brokerProtocolVersion);
    return {
      commit,
      version: pkg.version,
      brokerProtocol,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof SyntaxError)
      throw new AppError(
        "INVALID_REQUEST",
        "The update repository contains an invalid package.json release manifest.",
        409,
      );
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function probeInstalledBrokerProtocol(
  protocol: number | undefined,
): Promise<BrokerProbe> {
  if (!protocol) return { brokerState: "unavailable" };
  try {
    const result = await runCommand("/usr/bin/sudo", ["-n", BROKER_PATH], {
      input: JSON.stringify({
        protocolVersion: protocol,
        action: "broker-health",
      }),
      timeout: 10_000,
    });
    let payload: {
      ok?: boolean;
      code?: string;
      data?: {
        protocolVersion?: number;
        privileged?: boolean;
        cloudPanelAvailable?: boolean;
      };
    } = {};
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return { brokerState: "unavailable" };
    }
    const reported = Number.isInteger(payload.data?.protocolVersion)
      ? Number(payload.data?.protocolVersion)
      : undefined;
    if (
      result.code === 0 &&
      payload.ok === true &&
      reported === protocol &&
      payload.data?.privileged === true &&
      payload.data?.cloudPanelAvailable === true
    )
      return { brokerState: "healthy", installedBrokerProtocol: reported };
    if (payload.code === "BROKER_PROTOCOL_MISMATCH")
      return { brokerState: "mismatch", installedBrokerProtocol: reported };
    return { brokerState: "unavailable", installedBrokerProtocol: reported };
  } catch {
    return { brokerState: "unavailable" };
  }
}

export async function getUpdateState(
  checkRemote = false,
): Promise<UpdateState> {
  const settings = await getPanelSettings();
  const stored = await effectiveState();
  const installedRelease = await currentRelease();
  const configuredRepository =
    settings.updateRepository || stored.repository || "";
  const repository = configuredRepository
    ? validateUpdateRepository(configuredRepository)
    : "";
  const base: UpdateState = {
    status: stored.status || "idle",
    currentVersion: installedRelease.version,
    repository,
    branch: UPDATE_BRANCH,
    installedCommit: stored.installedCommit,
    remoteCommit: stored.remoteCommit,
    remoteVersion: stored.remoteVersion,
    installedBrokerProtocol: stored.installedBrokerProtocol,
    requiredBrokerProtocol: stored.requiredBrokerProtocol,
    brokerState: stored.brokerState,
    notice: stored.notice,
    startedAt: stored.startedAt,
    completedAt: stored.completedAt,
    error: stored.error,
    previousPid: stored.previousPid,
    logFile: join(dataDir(), "update.log"),
  };
  if (!repository) {
    if (checkRemote)
      throw new AppError(
        "INVALID_REQUEST",
        "Configure a public update repository before checking for updates.",
        409,
      );
    return {
      ...base,
      status: "idle",
      error: "Configure a public HTTPS Git repository to enable updates.",
    };
  }
  if (!checkRemote || ["queued", "updating", "reloading"].includes(base.status))
    return base;
  try {
    const [remote, broker] = await Promise.all([
      gitRemoteRelease(repository),
      probeInstalledBrokerProtocol(installedRelease.brokerProtocol),
    ]);
    const classification = classifyUpdate({
      currentVersion: installedRelease.version,
      installedCommit: base.installedCommit,
      remoteVersion: remote.version,
      remoteCommit: remote.commit,
      installedBrokerProtocol: broker.installedBrokerProtocol,
      requiredBrokerProtocol: remote.brokerProtocol,
      brokerState: broker.brokerState || "unavailable",
    });
    const state = {
      ...base,
      ...classification,
      ...broker,
      remoteCommit: remote.commit,
      remoteVersion: remote.version,
      requiredBrokerProtocol: remote.brokerProtocol,
      error: undefined,
    } as UpdateState;
    await saveState(state);
    return state;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "CLOUDPANEL_UNAVAILABLE",
      "The update repository could not be reached.",
      502,
    );
  }
}

export async function queueUpdate() {
  const state = await getUpdateState(true);
  if (["queued", "updating", "reloading"].includes(state.status))
    throw new AppError("INVALID_REQUEST", "An update is already running.", 409);
  if (isUpdateCurrent(state))
    throw new AppError(
      "INVALID_REQUEST",
      "Panelavo is already up to date.",
      409,
    );
  if (state.status !== "available")
    throw new AppError(
      "INVALID_REQUEST",
      state.notice || "This release is not safe to install as an update.",
      409,
    );
  const queued: UpdateState = {
    ...state,
    status: "queued",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
    previousPid: process.pid,
  };
  await saveState(queued);
  const child = spawn(
    "/usr/bin/bash",
    [
      join(process.cwd(), "scripts", "self-update.sh"),
      state.repository,
      UPDATE_BRANCH,
      process.cwd(),
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      shell: false,
    },
  );
  child.on("error", () => undefined);
  child.unref();
  return queued;
}
