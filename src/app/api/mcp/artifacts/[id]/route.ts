import type { NextRequest } from "next/server";
import { writableSiteForActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import {
  deleteArtifactUpload,
  getArtifactUpload,
  writeArtifactChunk,
} from "@/server/mcp/artifacts";
import { authenticateMcpBearer } from "@/server/mcp/oauth";
import { audit } from "@/server/security/log";
import { rateLimit } from "@/server/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

async function authenticate(request: NextRequest) {
  const authenticated = await authenticateMcpBearer(request);
  if (authenticated instanceof Response) return authenticated;
  rateLimit(
    `mcp:artifact:${authenticated.actor.credentialId ?? authenticated.authInfo.clientId}`,
    240,
    60_000,
  );
  return authenticated;
}

function contentRange(request: NextRequest) {
  const value = request.headers.get("content-range") ?? "";
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match)
    throw new AppError(
      "INVALID_REQUEST",
      "Send Content-Range as bytes <start>-<end>/<total>.",
      400,
    );
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    const upload = await getArtifactUpload(
      authenticated.actor,
      (await context.params).id,
    );
    await writableSiteForActor(authenticated.actor, upload.domain);
    return ok(upload);
  } catch (error) {
    return fail(error);
  }
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    const upload = await getArtifactUpload(
      authenticated.actor,
      (await context.params).id,
    );
    await writableSiteForActor(authenticated.actor, upload.domain);
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        "upload-offset": String(upload.receivedBytes),
        "upload-length": String(upload.expectedBytes),
        "upload-status": upload.status,
        "upload-expires": upload.expiresAt,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    if (!request.body)
      throw new AppError("INVALID_REQUEST", "Upload body is required.", 400);
    const id = (await context.params).id;
    const current = await getArtifactUpload(authenticated.actor, id);
    await writableSiteForActor(authenticated.actor, current.domain);
    const range = contentRange(request);
    const length = request.headers.get("content-length");
    const upload = await writeArtifactChunk(authenticated.actor, id, {
      ...range,
      contentLength: length === null ? undefined : Number(length),
      body: request.body as unknown as AsyncIterable<Uint8Array>,
    });
    if (upload.status === "complete")
      await audit("mcp.artifact.uploaded", "success", {
        actor: authenticated.actor.user,
        target: { type: "site", id: upload.domain },
        details: {
          artifactId: upload.id,
          bytes: upload.expectedBytes,
          sha256: upload.expectedSha256,
        },
      });
    return ok(upload);
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    const id = (await context.params).id;
    const current = await getArtifactUpload(authenticated.actor, id);
    await writableSiteForActor(authenticated.actor, current.domain);
    return ok(await deleteArtifactUpload(authenticated.actor, id));
  } catch (error) {
    return fail(error);
  }
}

