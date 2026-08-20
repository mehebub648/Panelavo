import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError(
        "FORBIDDEN",
        "Safe storage cleanup is available to super administrators only.",
        403,
      );
    const input = (await request.json()) as { confirmation?: unknown };
    if (input.confirmation !== "RECLAIM BUILD CACHE")
      throw new AppError(
        "INVALID_REQUEST",
        "The storage cleanup confirmation was invalid.",
        400,
      );
    return ok({
      cleanup: await getCloudPanelClient().reclaimServerStorage(
        session.record.cloudPanel,
      ),
    });
  } catch (error) {
    return fail(error);
  }
}
