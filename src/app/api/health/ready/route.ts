import { NextResponse } from "next/server";
import { getReadiness } from "@/server/health/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const result = await getReadiness();
  return NextResponse.json(
    {
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
    },
    {
      status: result.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
