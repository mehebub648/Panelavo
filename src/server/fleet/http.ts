import type { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";

const MAX_FEDERATION_BODY_BYTES = 12 * 1024 * 1024;

export async function readFleetJson<T = unknown>(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_FEDERATION_BODY_BYTES)
    throw new AppError(
      "INVALID_REQUEST",
      "The federation request is too large.",
      413,
    );
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FEDERATION_BODY_BYTES)
    throw new AppError(
      "INVALID_REQUEST",
      "The federation request is too large.",
      413,
    );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      "INVALID_REQUEST",
      "The federation request is not valid JSON.",
      400,
    );
  }
}
