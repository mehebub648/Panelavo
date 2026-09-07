import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import { getFleetPublicState } from "@/server/fleet/service";
import { fail, ok } from "@/server/http";
import { AppError } from "@/server/cloudpanel/errors";

// Read compatibility for older open tabs; trust configuration now lives in Settings.
export async function GET() {
  try {
    await requireFleetSuperAdmin();
    return ok(await getFleetPublicState());
  } catch (error) {
    return fail(error);
  }
}
export async function POST() {
  try {
    await requireFleetSuperAdmin();
    throw new AppError(
      "INVALID_REQUEST",
      "Manage connected servers in Settings. Reload this page to continue.",
      410,
    );
  } catch (error) {
    return fail(error);
  }
}
