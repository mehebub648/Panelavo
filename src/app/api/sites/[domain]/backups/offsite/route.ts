import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSiteBackupAutomationForActor,
  manageSiteOffsiteBackupForActor,
  removeSiteOffsiteDestinationForActor,
  saveSiteOffsiteDestinationForActor,
} from "@/server/sites/site-automation-service";

const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upload"),
      id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("restore"),
      id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    })
    .strict(),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const session = await requireUser();
    const data = await getSiteBackupAutomationForActor(
      panelActorFromSession(session),
      decodeURIComponent((await params).domain),
    );
    return ok({ destination: data.destination, items: data.offsiteBackups });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const result = await saveSiteOffsiteDestinationForActor(
      panelActorFromSession(session),
      decodeURIComponent((await params).domain),
      await request.json(),
    );
    return ok({
      destination: result.destination,
      items: result.offsiteBackups,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const domain = decodeURIComponent((await params).domain);
    const input = actionSchema.parse(await request.json());
    const result = await manageSiteOffsiteBackupForActor(
      panelActorFromSession(session),
      domain,
      input.action,
      input.id,
    );
    return ok({ items: result.offsiteBackups });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    return ok(
      await removeSiteOffsiteDestinationForActor(
        panelActorFromSession(session),
        decodeURIComponent((await params).domain),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
