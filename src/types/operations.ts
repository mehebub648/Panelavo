import type { SiteType } from "@/types/cloudpanel";

export type OperationStatus =
  "ready" | "warning" | "blocked" | "unauthorized" | "unsupported";

export type OperationRisk = "safe" | "disruptive" | "destructive";
export type OperationScope = "site-user" | "site" | "service" | "host-root";

export type Pm2Process = {
  name: string;
  status: string;
  cpu: number;
  memory: number;
  restarts: number;
  pid?: number;
  uptimeSeconds?: number;
};

export type RuntimeContainer = {
  name: string;
  service: string;
  state: string;
  health?: string;
  status?: string;
  ports?: string[];
};

export type SiteListener = {
  port: number;
  address: string;
  process?: string;
};

// Sync verdict between the configured .env and the environment the running
// process actually has. Only key names and verdicts reach the browser.
export type RuntimeEnvKey = {
  key: string;
  status: "match" | "differs" | "missing" | "unknown";
};

export type RuntimeInfo = {
  containers?: RuntimeContainer[];
  listeners?: SiteListener[];
  envFile?: string | null;
  env?: RuntimeEnvKey[];
  checkedAt?: string;
};

export type OperationTool = {
  id: string;
  label: string;
  available: boolean;
  version?: string;
  detail?: string;
};

export type DependencyManager = {
  id: string;
  label: string;
  available: boolean;
  lockfile?: string;
  ambiguous?: boolean;
  detail?: string;
};

export type ComposeCapability = {
  file?: string;
  cliAvailable: boolean;
  pluginAvailable: boolean;
  daemonAvailable: boolean;
  configValid?: boolean;
  safe?: boolean;
  version?: string;
  services?: string[];
  runningServices?: number;
  totalServices?: number;
  expectedPort?: number;
  entryService?: string;
  containerPort?: number;
  publishedPort?: number;
  portMatches?: boolean;
  canAutoRemap?: boolean;
  runtimeOverride?: boolean;
  portDetail?: string;
  additionalPorts?: ServicePort[];
  detail?: string;
  missingEnvVariables?: string[];
  warnings?: string[];
};

export type ServicePort = {
  service: string;
  containerPort: number;
  publishedPort?: number;
  hostIp?: string;
};

export type SitePortCapability = {
  expected?: number;
  listening: boolean;
  detected: number[];
  detail: string;
};

export type OperationStepResult = {
  command: string;
  label: string;
  display: string;
  exitCode: number;
  timedOut?: boolean;
  output: string;
};

export type OperationRun = {
  command: string;
  display: string;
  exitCode: number;
  timedOut?: boolean;
  output: string;
  plan?: string;
  startedAt?: string;
  finishedAt?: string;
  steps?: OperationStepResult[];
};

export type RawOperationsData = {
  type?: SiteType | string;
  path?: string;
  framework?: string;
  processName?: string;
  reverseProxyUrl?: string;
  expectedPort?: number;
  port?: SitePortCapability;
  checkedAt?: string;
  hasPackageJson?: boolean;
  hasPackageLock?: boolean;
  hasBuildScript?: boolean;
  hasStartScript?: boolean;
  scripts?: { name: string; command: string }[];
  hasComposer?: boolean;
  hasComposerLock?: boolean;
  hasArtisan?: boolean;
  hasSymfonyConsole?: boolean;
  hasWordPress?: boolean;
  hasRequirements?: boolean;
  hasPyproject?: boolean;
  hasPipfile?: boolean;
  hasPythonVenv?: boolean;
  hasManagePy?: boolean;
  hasCompose?: boolean;
  hasEcosystem?: boolean;
  hasIndexHtml?: boolean;
  hasWorkspace?: boolean;
  hasEnvFile?: boolean;
  packageManager?: DependencyManager;
  pythonManager?: DependencyManager;
  tools?: Record<string, OperationTool>;
  compose?: ComposeCapability;
  permissions?: { manage: boolean; docker: boolean };
  pm2Available?: boolean;
  dockerAvailable?: boolean;
  pm2?: Pm2Process[];
  listeners?: SiteListener[];
  runtime?: RuntimeInfo;
  run?: OperationRun;
};

export type ArchitectureDetection = {
  id: string;
  kind: string;
  label: string;
  framework?: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
};

export type OperationFixId =
  | "install-docker"
  | "install-compose-plugin"
  | "start-docker"
  | "install-composer";

// A server-owned remediation for a failed preflight check: one click runs an
// allow-listed, host-scoped repair (for installs: latest release from the
// official upstream source, never a stale distribution package).
export type OperationFix = {
  id: OperationFixId;
  label: string;
  description: string;
  risk: OperationRisk;
  scope: OperationScope;
  status: OperationStatus;
  blockedBy: string[];
  confirmation?: {
    title: string;
    message: string;
    confirmText?: string;
  };
};

export type OperationCheck = {
  id: string;
  label: string;
  status: OperationStatus;
  detail: string;
  blocker: boolean;
  remediation?: string;
  fix?: OperationFix;
};

export type OperationAction = {
  id: string;
  group: string;
  label: string;
  description: string;
  iconKey:
    | "box"
    | "build"
    | "cache"
    | "check"
    | "database"
    | "logs"
    | "package"
    | "play"
    | "refresh"
    | "stop"
    | "terminal"
    | "trash";
  commandPreview?: string;
  status: OperationStatus;
  blockedBy: string[];
  risk: OperationRisk;
  scope: OperationScope;
  input?: { script?: string; name?: string };
  confirmation?: {
    title: string;
    message: string;
    confirmText?: string;
  };
};

export type OperationActionGroup = {
  id: string;
  title: string;
  description: string;
  actions: OperationAction[];
};

export type DeploymentPlan = {
  id: "compose" | "node" | "static-build" | "php" | "python";
  label: string;
  description: string;
  status: OperationStatus;
  risk: OperationRisk;
  scope: OperationScope;
  blockedBy: string[];
  warnings: string[];
  steps: { command: string; label: string; description: string }[];
  confirmation?: {
    title: string;
    message: string;
    confirmText?: string;
  };
};

export type OperationsData = RawOperationsData & {
  schemaVersion: 1;
  type: SiteType | string;
  path: string;
  architecture: {
    primary: ArchitectureDetection;
    alternatives: ArchitectureDetection[];
  };
  preflight: {
    status: OperationStatus;
    checkedAt: string;
    checks: OperationCheck[];
  };
  plan?: DeploymentPlan;
  groups: OperationActionGroup[];
};
