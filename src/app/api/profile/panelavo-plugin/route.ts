import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { fail } from "@/server/http";
import { pluginUrls } from "@/server/plugin/config";
import { buildPanelavoPluginZip } from "@/server/plugin/package";

export async function GET(request: NextRequest) {
  try {
    await requireUser({ allowDuringUpdate: true });
    const urls = pluginUrls(request);
    const archive = await buildPanelavoPluginZip(urls);
    return new Response(new Uint8Array(archive), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="panelavo-plugin.zip"',
        "content-type": "application/zip",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
