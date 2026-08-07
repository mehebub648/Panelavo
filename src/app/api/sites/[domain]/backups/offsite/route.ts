import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import {
  deleteOffsiteBackup,
  getOffsiteDestination,
  listOffsiteBackups,
  offsiteDestinationSchema,
  removeOffsiteDestination,
  restoreOffsiteBackup,
  saveOffsiteDestination,
  uploadOffsiteBackup,
} from "@/server/backups/offsite";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upload"), id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
  z.object({ action: z.literal("restore"), id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
]);

async function authorized(encodedDomain: string, write = false) {
  const session = await requireUser();
  const domain = decodeURIComponent(encodedDomain);
  await getCloudPanelClient().getSiteSection(session.record.cloudPanel, domain, "backups");
  if (write && !(session.user.canCreateSites || session.user.panelRole === "admin"))
    throw new AppError("FORBIDDEN", "You do not have permission to manage these backups.", 403);
  return { session, domain };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const { domain } = await authorized((await params).domain);
    const [destination, items] = await Promise.all([
      getOffsiteDestination(domain),
      listOffsiteBackups(domain).catch(() => []),
    ]);
    return ok({ destination, items });
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
    const { domain } = await authorized((await params).domain, true);
    const destination = await saveOffsiteDestination(
      domain,
      offsiteDestinationSchema.parse(await request.json()),
    );
    return ok({ destination, items: await listOffsiteBackups(domain) });
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
    const { session, domain } = await authorized((await params).domain, true);
    const input = actionSchema.parse(await request.json());
    if (input.action === "upload") await uploadOffsiteBackup(domain, input.id);
    if (input.action === "delete") await deleteOffsiteBackup(domain, input.id);
    if (input.action === "restore") {
      await restoreOffsiteBackup(domain, input.id);
      await getCloudPanelClient().manageSiteSection(
        session.record.cloudPanel,
        domain,
        "backups",
        { action: "restore", id: input.id, scope: "all" },
      );
    }
    return ok({ items: await listOffsiteBackups(domain) });
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
    const { domain } = await authorized((await params).domain, true);
    await removeOffsiteDestination(domain);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
