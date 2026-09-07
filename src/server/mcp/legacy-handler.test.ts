import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelActor } from "@/server/auth/site-access";
import { createLegacyMcpHandler } from "./legacy-handler";
import { createMcpConfirmationManager } from "./confirmation";

const actor = {
  user: {
    id: "42",
    username: "alice",
    panelRole: "admin",
    canCreateSites: true,
  },
  cloudPanel: { cookies: {}, usernameHint: "alice", cliAuthenticated: true },
  authentication: "mcp",
  credentialId: "token-1",
} as PanelActor;
const auth = {
  token: "test-token",
  clientId: "client-1",
  scopes: [],
  extra: { panelavoActor: actor },
} as AuthInfo;
function req(body: unknown, session?: string, method = "POST") {
  return new Request("https://panel.example/mcp", {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
async function firstMessage(response: Response) {
  const reader = response.body!.getReader();
  let buffer = "";
  return {
    reader,
    next: async () => {
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index >= 0) {
          const event = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = event
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE ended without a message");
          buffer += new TextDecoder().decode(chunk.value);
        }
      }
    },
  };
}
describe("legacy HTTP sessions", () => {
  afterEach(() => vi.useRealTimers());
  it("delivers a real confirmation and executes only after the client accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "panel-mcp-http-"));
    process.env.PANEL_DATA_DIR = dir;
    process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters";
    const execute = vi.fn();
    const handle = createLegacyMcpHandler(() => {
      const confirmations = createMcpConfirmationManager(actor);
      const server = new McpServer(
        { name: "test", version: "1" },
        {
          requestState: { verify: confirmations.verifyRequestState },
        },
      );
      server.registerTool(
        "deploy",
        { inputSchema: {} },
        async (_args, context) => {
          const approval = await confirmations.require({
            context,
            tool: "deploy",
            arguments: {},
            message: "Deploy test site?",
          });
          if (approval) return approval;
          execute();
          return { content: [{ type: "text", text: "deployed" }] };
        },
      );
      return server;
    });
    const initialized = await handle(
      req({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: "test", version: "1" },
        },
      }),
      auth,
    );
    const session = initialized.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    await initialized.text();
    await handle(
      req({ jsonrpc: "2.0", method: "notifications/initialized" }, session),
      auth,
    );
    try {
      const stream = await firstMessage(
        await handle(
          req(
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "deploy", arguments: {} },
            },
            session,
          ),
          auth,
        ),
      );
      const prompt = await stream.next();
      expect(prompt.method).toBe("elicitation/create");
      expect(execute).not.toHaveBeenCalled();
      const foreign = await handle(
        req(
          {
            jsonrpc: "2.0",
            id: prompt.id,
            result: { action: "accept", content: { confirm: true } },
          },
          session,
        ),
        { ...auth, token: "another-token" },
      );
      expect(foreign.status).toBe(404);
      expect(execute).not.toHaveBeenCalled();
      await handle(
        req(
          {
            jsonrpc: "2.0",
            id: prompt.id,
            result: { action: "accept", content: { confirm: true } },
          },
          session,
        ),
        auth,
      );
      expect((await stream.next()).result.content[0].text).toBe("deployed");
      expect(execute).toHaveBeenCalledTimes(1);
      await stream.reader.cancel();
      const changedRole = {
        ...auth,
        extra: {
          panelavoActor: {
            ...actor,
            user: { ...actor.user, panelRole: "user" },
          },
        },
      };
      expect(
        (
          await handle(
            req({ jsonrpc: "2.0", id: 3, method: "tools/list" }, session),
            changedRole,
          )
        ).status,
      ).toBe(404);
      await handle(req(undefined, session, "DELETE"), auth);
      expect((await handle(req({}, session), auth)).status).toBe(404);
    } finally {
      delete process.env.PANEL_DATA_DIR;
      delete process.env.SESSION_SECRET;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("requires initialization and bounds per-credential sessions", async () => {
    const handle = createLegacyMcpHandler(
      () => new McpServer({ name: "test", version: "1" }),
    );
    expect(
      (await handle(req({ jsonrpc: "2.0", id: 1, method: "tools/list" }), auth))
        .status,
    ).toBe(400);
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const response = await handle(
        req({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
        auth,
      );
      expect(response.status).toBe(i === 20 ? 429 : 200);
      if (i < 20) ids.push(response.headers.get("mcp-session-id")!);
      await response.text();
    }
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect((await handle(req({}, ids[0]), auth)).status).toBe(404);
  });
});
