import type { NextRequest } from "next/server";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import { requireUser } from "@/server/auth/require-user";
import {
  panelActorFromSession,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import {
  getSiteSectionForActor,
  manageSiteSectionForActor,
} from "@/server/sites/site-section-service";

const readableSections = new Set(["git", "users", "logs", "cron-jobs"]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    const session = await requireUser();
    const { domain, section } = await params;
    if (!readableSections.has(section))
      throw new AppError(
        "INVALID_REQUEST",
        "That website section is not available from this endpoint.",
        404,
      );
    const actor = panelActorFromSession(session);
    const decodedDomain = decodeURIComponent(domain);
    if (section !== "git") await writableSiteForActor(actor, decodedDomain);
    return ok(await getSiteSectionForActor(actor, decodedDomain, section));
  } catch (error) {
    return fail(error);
  }
}

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
