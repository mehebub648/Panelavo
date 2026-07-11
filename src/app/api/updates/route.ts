import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { audit } from "@/server/security/log";
import { getUpdateState, queueUpdate, validateUpdateRepository } from "@/server/updates/panel-updater";
import { setUpdateRepository } from "@/server/settings/store";

async function requireSuperAdmin(allowDuringUpdate = false) {
  const session = await requireUser({ allowDuringUpdate });
  if (session.user.panelRole !== "super-admin") throw new AppError("FORBIDDEN", "Panel updates are available to super administrators only.", 403);
  return session;
}
export async function GET(request: NextRequest) {
  try { await requireSuperAdmin(true); return ok(await getUpdateState(request.nextUrl.searchParams.get("check") === "true")); }
  catch (error) { return fail(error); }
}
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-repository"), repository: z.string() }).strict(),
  z.object({ action: z.literal("update") }).strict(),
]);
export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request); const session = await requireSuperAdmin();
    rateLimit(`panel-update:${session.user.id}`, 5, 60_000);
    const input = schema.parse(await request.json());
    if (input.action === "save-repository") {
      const repository = validateUpdateRepository(input.repository); await setUpdateRepository(repository);
      audit("panel.update-repository", "success", { user: session.user.username });
      return ok(await getUpdateState(true));
    }
    const state = await queueUpdate(); audit("panel.update", "success", { user: session.user.username, repository: state.repository });
    return ok(state, { status: 202 });
  } catch (error) { audit("panel.update", "failure", {}); return fail(error); }
}
