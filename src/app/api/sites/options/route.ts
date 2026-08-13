import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getSiteCreationDetails } from "@/server/sites/site-service";

export async function GET() {
  try {
    const session = await requireUser();
    return ok(await getSiteCreationDetails(panelActorFromSession(session)));
  } catch (error) {
    return fail(error);
  }
}
