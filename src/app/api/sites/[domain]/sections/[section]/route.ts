import type { NextRequest } from "next/server";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { manageSiteSectionForActor } from "@/server/sites/site-section-service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    assertWriteRequest(request);
    const { domain, section } = await params;
    const decodedDomain = decodeURIComponent(domain);
    const session = await requireUser();
    const data = await manageSiteSectionForActor(
      panelActorFromSession(session),
      decodedDomain,
      section,
      await request.json(),
    );
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
