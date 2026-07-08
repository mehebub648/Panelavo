import { getSession } from "@/server/auth/session";
import { fail, ok } from "@/server/http";

export async function GET() {
  try {
    const session = await getSession({ allowPending: true });
    return ok({
      authenticated: Boolean(session?.record.user),
      twoFactorPending: Boolean(session?.record.twoFactorPending),
      user: session?.record.user,
    });
  } catch (error) {
    return fail(error);
  }
}
