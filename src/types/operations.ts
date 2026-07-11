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
  detail?: string;
  warnings?: string[];
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

export type OperationCheck = {
  id: string;
  label: string;
  status: OperationStatus;
  detail: string;
  blocker: boolean;
  remediation?: string;
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
