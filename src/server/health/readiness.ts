import { checkCloudPanelBroker } from "@/server/cloudpanel/live-client";

export type ReadinessState = "pass" | "fail";

export type ReadinessResult = {
  ready: boolean;
  checks: {
    configuration: ReadinessState;
    cloudPanel: ReadinessState;
  };
};

type ReadinessOptions = {
  env?: NodeJS.ProcessEnv;
  checkDependency?: () => Promise<void>;
};

export function hasRequiredProductionConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_ENV !== "production") return true;

  const sessionSecret = env.SESSION_SECRET ?? "";
  const encryptionKey = env.CREDENTIALS_ENCRYPTION_KEY ?? "";
  return (
    sessionSecret.length >= 32 &&
    encryptionKey.length >= 32 &&
    encryptionKey !== sessionSecret
  );
}

export async function getReadiness(
  options: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const configuration = hasRequiredProductionConfiguration(options.env)
    ? "pass"
    : "fail";
  let cloudPanel: ReadinessState = "fail";

  try {
    await (options.checkDependency ?? checkCloudPanelBroker)();
    cloudPanel = "pass";
  } catch {
    // Dependency errors are intentionally collapsed to a status. This endpoint
    // is public and must not expose command paths, stderr, or host details.
  }

  return {
    ready: configuration === "pass" && cloudPanel === "pass",
    checks: { configuration, cloudPanel },
  };
}
