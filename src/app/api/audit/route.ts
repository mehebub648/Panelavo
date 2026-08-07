import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { auditQueryFromSearchParams } from "@/server/security/audit-query";
import { readAuditEvents } from "@/server/security/log";

export async function GET(request: NextRequest) {
  try {
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError(
        "FORBIDDEN",
        "The audit trail is available to super administrators only.",
        403,
      );
    return ok(
      await readAuditEvents(
        auditQueryFromSearchParams(request.nextUrl.searchParams),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
