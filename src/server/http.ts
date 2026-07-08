import { NextResponse } from "next/server";
import { publicMessage } from "@/server/cloudpanel/errors";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(
    { success: true, data },
    { ...init, headers: { "cache-control": "no-store", ...init?.headers } },
  );
}

export function fail(error: unknown) {
  const value = publicMessage(error);
  return NextResponse.json(
    { success: false, error: { code: value.code, message: value.message } },
    { status: value.status, headers: { "cache-control": "no-store" } },
  );
}
