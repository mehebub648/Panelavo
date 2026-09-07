import { createHash, randomUUID } from "node:crypto";
import {
  type AuthInfo,
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
} from "@modelcontextprotocol/server";

const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 500;
const MAX_PER_CREDENTIAL = 20;

/** Keep negotiated capabilities and reverse requests on authenticated sessions. */
export function createLegacyMcpHandler(factory: (auth: AuthInfo) => McpServer) {
  const sessions = new Map<
    string,
    {
      binding: string;
      server: McpServer;
      transport: WebStandardStreamableHTTPServerTransport;
      touched: number;
    }
  >();
  const failure = (status: number, message: string) =>
    Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message },
      },
      { status },
    );

  return async (request: Request, auth: AuthInfo) => {
    // Authentication and live actor resolution occur before every invocation.
    // A changed actor/role or credential requires a fresh initialization.
    const binding = createHash("sha256")
      .update(
        JSON.stringify([auth.token, auth.clientId, auth.extra?.panelavoActor]),
      )
      .digest("hex");
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.touched > IDLE_MS) {
        sessions.delete(id);
        await session.server.close();
      }
    }
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const session = sessions.get(id);
      if (!session || session.binding !== binding)
        return failure(
          404,
          "MCP session expired or belongs to another connection. Initialize again.",
        );
      session.touched = now;
      return session.transport.handleRequest(request, { authInfo: auth });
    }
    if (request.method !== "POST")
      return failure(400, "Initialize an MCP session first.");
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return failure(400, "Invalid MCP JSON request.");
    }
    if (!isInitializeRequest(body))
      return failure(400, "Initialize an MCP session first.");
    if (
      sessions.size >= MAX_SESSIONS ||
      [...sessions.values()].filter((s) => s.binding === binding).length >=
        MAX_PER_CREDENTIAL
    )
      return failure(
        429,
        "Too many active MCP sessions. Close an existing session first.",
      );

    const sessionId = randomUUID();
    const server = factory(auth);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessionclosed: () => {
        sessions.delete(sessionId);
      },
    });
    // Reserve before awaiting so concurrent initializations obey the limit.
    sessions.set(sessionId, { binding, server, transport, touched: now });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo: auth,
      });
      if (!response.ok) {
        sessions.delete(sessionId);
        await server.close();
      }
      return response;
    } catch (error) {
      sessions.delete(sessionId);
      await server.close();
      throw error;
    }
  };
}
