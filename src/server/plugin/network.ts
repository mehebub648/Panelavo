import { request as httpsRequest } from "node:https";
import { resolveFleetOrigin } from "@/server/fleet/network";

const ALLOWED_PATHS = new Set([
  "/mcp",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
]);
const MAX_BYTES = 8 * 1024 * 1024;

/** TLS and DNS-pinned requests to fixed Panelavo endpoints; redirects are never followed. */
export async function panelFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (!ALLOWED_PATHS.has(target.pathname) || target.search || target.hash)
    throw new Error("Only Panelavo MCP and OAuth endpoints can be contacted.");
  const { url, addresses } = await resolveFleetOrigin(target.origin);
  // Allow ordinary global IPv6 only; reject mapped/translation/tunnel ranges.
  if (
    addresses.some(
      ({ address, family }) =>
        family === 6 &&
        (!/^[23][0-9a-f]{3}:/i.test(address) || /^200[12]:/i.test(address)),
    )
  )
    throw new Error(
      "The Panelavo address must resolve to public internet addresses.",
    );
  const selected = addresses[0];
  const payload = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  if (payload && payload.length > MAX_BYTES)
    throw new Error("The Panelavo request is too large.");
  if (request.signal.aborted)
    throw new Error("The Panelavo request was cancelled.");
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: 443,
        path: target.pathname,
        method: request.method,
        agent: false,
        headers: Object.fromEntries(request.headers),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.resume();
          reject(
            new Error(
              "Use the canonical Panelavo address; redirects are not followed.",
            ),
          );
          return;
        }
        let size = 0;
        let ended = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on("data", (chunk: Buffer) => {
              if (ended) return;
              size += chunk.length;
              if (size > MAX_BYTES) {
                outgoing.destroy(
                  new Error("The Panelavo response is too large."),
                );
                return;
              }
              controller.enqueue(chunk);
            });
            incoming.on("end", () => {
              if (!ended) {
                ended = true;
                controller.close();
              }
            });
            incoming.on("error", (error) => {
              if (!ended) {
                ended = true;
                controller.error(error);
              }
            });
          },
          cancel() {
            ended = true;
            outgoing.destroy();
          },
        });
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers }));
        } else resolve(new Response(body, { status, headers }));
      },
    );
    const deadline = setTimeout(
      () => outgoing.destroy(new Error("The Panelavo request timed out.")),
      target.pathname === "/mcp" ? 30 * 60_000 : 20_000,
    );
    const abort = () =>
      outgoing.destroy(new Error("The Panelavo request was cancelled."));
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", abort);
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

export async function panelJson<T>(
  origin: string,
  path: string,
  body: unknown,
  form = false,
): Promise<T> {
  const response = await panelFetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
      accept: "application/json",
    },
    body: form ? String(body) : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Panelavo rejected the connection (${response.status}). Sign in again.`,
    );
  }
  return response.json() as Promise<T>;
}
