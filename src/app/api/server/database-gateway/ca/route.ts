import { requireUser } from "@/server/auth/require-user";
import { getDatabaseGatewayCa } from "@/server/cloudpanel/live-client";
import { fail } from "@/server/http";

export async function GET() {
  try {
    await requireUser();
    const result = await getDatabaseGatewayCa();
    return new Response(result.certificate, {
      headers: {
        "content-type": "application/x-pem-file",
        "content-disposition": `attachment; filename="panelavo-database-ca.pem"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
