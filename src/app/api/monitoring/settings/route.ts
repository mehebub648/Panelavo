import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import { getMonitoringSettings, monitoringSettingsSchema, saveMonitoringSettings } from "@/server/monitoring/store";

async function requireSuperAdmin() { const session = await requireUser(); if (session.user.panelRole !== "super-admin") throw new AppError("FORBIDDEN", "Monitoring settings are available to super administrators only.", 403); }
export async function GET() { try { await requireSuperAdmin(); return ok(await getMonitoringSettings()); } catch (error) { return fail(error); } }
export async function PUT(request: NextRequest) { try { assertWriteRequest(request); await requireSuperAdmin(); return ok(await saveMonitoringSettings(monitoringSettingsSchema.parse(await request.json()))); } catch (error) { return fail(error); } }
