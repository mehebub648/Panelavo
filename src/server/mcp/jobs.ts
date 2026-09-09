// MCP jobs retain credential-bound visibility and their existing API.
export {
  getMcpJob,
  listMcpJobs,
  cancelMcpJob,
} from "@/server/jobs/background-jobs";
export type { McpJob, McpJobStatus } from "@/server/jobs/background-jobs";
import {
  startBackgroundJob,
  type JobWork,
} from "@/server/jobs/background-jobs";
import type { PanelActor } from "@/server/auth/site-access";
export function startMcpJob(
  actor: PanelActor,
  input: {
    domain: string;
    kind: string;
    timeoutSeconds: number;
    cancellable?: boolean;
  },
  work: JobWork,
) {
  return startBackgroundJob(
    actor,
    {
      domain: input.domain,
      kind: input.kind,
      timeoutSeconds: input.timeoutSeconds,
      cancellable: input.cancellable,
    },
    work,
  );
}
