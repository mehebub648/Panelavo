import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import {
  backupRequestSchema,
  envRequestSchema,
  gitRequestSchema,
  operationsRequestSchema,
  terminalRequestSchema,
} from "@/schemas/operations";
import { getDeployHooks } from "@/server/deploy/hooks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain, section } = await params;
    const submitted = await request.json();
    const input =
      section === "git"
        ? gitRequestSchema.parse(submitted)
        : section === "actions"
          ? operationsRequestSchema.parse(submitted)
          : section === "env"
            ? envRequestSchema.parse(submitted)
            : section === "terminal"
              ? terminalRequestSchema.parse(submitted)
              : section === "backups"
                ? backupRequestSchema.parse(submitted)
                : submitted;
    const operation =
      section === "git" && input.action === "pull"
        ? {
            ...input,
            deployOperations: await getDeployHooks(decodeURIComponent(domain)),
          }
        : input;
    const data = await getCloudPanelClient().manageSiteSection(
      session.record.cloudPanel,
      decodeURIComponent(domain),
      section,
      operation,
    );
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
