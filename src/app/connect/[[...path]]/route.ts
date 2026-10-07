import { pluginHttp } from "@/server/plugin/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
export const GET = pluginHttp;
export const POST = pluginHttp;
export const DELETE = pluginHttp;
