export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const value = process.env.PANELAVO_OPENAI_APPS_CHALLENGE;
  if (process.env.PANELAVO_PLUGIN_ENABLED !== "1" || !value)
    return new Response("Not found", { status: 404 });
  return new Response(value, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
