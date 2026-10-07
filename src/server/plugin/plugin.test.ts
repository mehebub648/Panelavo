import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { createLegacyMcpHandler } from "@/server/mcp/legacy-handler";

const network = vi.hoisted(() => ({ json: vi.fn(), fetch: vi.fn() }));
vi.mock("./network", () => ({
  panelJson: network.json,
  panelFetch: network.fetch,
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    getCurrentUser: async () => ({
      id: "42",
      username: "alice",
      status: true,
      panelRole: "user",
      canCreateSites: false,
    }),
  }),
}));

import {
  browserGroup,
  createGroup,
  digest,
  groupSubject,
  pluginTransaction,
  requireGroup,
  type PluginServer,
} from "./store";
import { beginServerLogin, finishServerLogin } from "./login";
import { disconnectServer, serverCredentials } from "./remote";
import { createPluginMcpServer } from "./server";
import { pluginHttp } from "./http";
import { pluginUrls, PLUGIN_COOKIE } from "./config";
import {
  clearMcpOAuthStoreForTests,
  completeMcpAuthorization,
  createMcpConsent,
  createMcpPersonalToken,
  createMcpTokenVerifier,
  exchangeMcpOAuthToken,
  mcpTokenVerifier,
  registerMcpOAuthClient,
  validateMcpAuthorizationRequest,
  type ValidatedMcpAuthorizationRequest,
} from "@/server/mcp/oauth";
import { getMcpPublicUrls } from "@/server/mcp/public-url";

const origin = "https://gateway.example.com";
const authorization = {
  clientId: "test-client",
} as ValidatedMcpAuthorizationRequest;
const remote = (): PluginServer => ({
  id: randomUUID(),
  origin: "https://source.example.com",
  label: "Production",
  clientId: "upstream-client",
  accessToken: "upstream-access-secret",
  refreshToken: "upstream-refresh-secret",
  expiresAt: Date.now() + 3600_000,
});
const tokenReply = () => ({
  access_token: "new-access-secret",
  refresh_token: "new-refresh-secret",
  token_type: "Bearer",
  scope: "panelavo:access",
  expires_in: 3600,
});
const data = (response: { structuredContent?: unknown }) =>
  response.structuredContent as Record<string, unknown>;
function req(
  path: string,
  body?: URLSearchParams,
  cookie?: string,
  from = origin,
) {
  return new NextRequest(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      host: "gateway.example.com",
      "x-forwarded-proto": "https",
      ...(body
        ? { origin: from, "content-type": "application/x-www-form-urlencoded" }
        : {}),
      ...(cookie ? { cookie: `${PLUGIN_COOKIE}=${cookie}` } : {}),
    },
    body,
  });
}
describe("Panelavo plugin isolation and browser OAuth", () => {
  let dir: string;
  const connections: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panelavo-plugin-"));
    vi.stubEnv("PANEL_DATA_DIR", dir);
    vi.stubEnv("SESSION_SECRET", "test-session-secret-longer-than-thirty-two");
    vi.stubEnv("PANELAVO_PLUGIN_ENABLED", "1");
    await clearMcpOAuthStoreForTests();
    network.json.mockReset();
    network.fetch.mockReset();
  });
  afterEach(async () => {
    for (const close of connections.splice(0)) await close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });
  const identity = () => ({
    id: "42",
    username: "alice",
    displayName: "Alice",
    role: "user",
    serverIp: "203.0.113.10",
    capabilities: {
      readWebsites: true,
      manageWebsites: false,
      createWebsites: false,
      hostWebsiteRepairs: false,
    },
  });
  async function upstream(account: Record<string, unknown> = identity()) {
    const writes = vi.fn();
    const handler = createLegacyMcpHandler(() => {
      const server = new McpServer({ name: "sample-panel", version: "1" });
      server.registerTool(
        "panelavo_whoami",
        { annotations: { readOnlyHint: true } },
        async () => ({
          content: [{ type: "text", text: JSON.stringify(account) }],
          structuredContent: account,
        }),
      );
      server.registerTool(
        "panelavo_write",
        {
          inputSchema: z.object({ filename: z.string() }),
          annotations: { readOnlyHint: false },
        },
        async ({ filename }, context) => {
          const answer = await context.mcpReq.elicitInput({
            message: "Change this sample file?",
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
              required: ["confirm"],
            },
          });
          if (answer.action !== "accept" || answer.content?.confirm !== true)
            return { content: [{ type: "text", text: "Cancelled" }] };
          writes(filename);
          return { content: [{ type: "text", text: "Changed" }] };
        },
      );
      return server;
    });
    network.fetch.mockImplementation(
      (input: string | URL | Request, init?: RequestInit) =>
        handler(new Request(input, init), {
          token: "upstream-access-secret",
          clientId: "upstream-client",
          scopes: [],
        }),
    );
    return writes;
  }
  async function gateway(groupId: string, accept = false) {
    const auth: AuthInfo = {
      token: `token-${groupId}`,
      clientId: "test-client",
      scopes: [],
      resource: new URL(`${origin}/connect/openai/mcp`),
      extra: { panelavoConnectionGroup: groupId },
    };
    const handler = createLegacyMcpHandler(createPluginMcpServer);
    const client = new Client(
      { name: "test", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const prompt = vi.fn(async () => ({
      action: accept ? ("accept" as const) : ("decline" as const),
      ...(accept ? { content: { confirm: true } } : {}),
    }));
    client.setRequestHandler("elicitation/create", prompt);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/connect/openai/mcp`),
      { fetch: (input, init) => handler(new Request(input, init), auth) },
    );
    await client.connect(transport);
    connections.push(async () => {
      await transport.terminateSession();
      await client.close();
    });
    return { client, prompt };
  }
  it("keeps browser cookies hashed and upstream credentials encrypted", async () => {
    const first = await createGroup(authorization);
    const second = await createGroup(authorization);
    const source = remote();
    await pluginTransaction((s) => {
      requireGroup(s, first.group.id).servers.push(source);
    });
    expect((await browserGroup(first.cookie))?.id).toBe(first.group.id);
    expect((await browserGroup(second.cookie))?.servers).toHaveLength(0);
    expect(await browserGroup("x".repeat(43))).toBeUndefined();
    const stored = await readFile(
      join(dir, "plugin-connections.enc.json"),
      "utf8",
    );
    for (const secret of [
      first.cookie,
      first.group.csrf,
      source.accessToken,
      source.refreshToken,
    ])
      expect(stored).not.toContain(secret);
    await expect(serverCredentials(second.group.id, source.id)).rejects.toThrow(
      "not connected",
    );
  });
  it("uses PKCE, rejects cross-browser and wrong-issuer callbacks, and consumes each state once", async () => {
    await upstream();
    const { group } = await createGroup(authorization);
    network.json.mockImplementation(async (_o, path) =>
      path === "/oauth/register"
        ? { client_id: "upstream-client" }
        : tokenReply(),
    );
    const login = new URL(
      await beginServerLogin(
        group.id,
        group.browserHash,
        { origin: "https://source.example.com", label: "Production" },
        origin,
      ),
    );
    expect(login.searchParams.get("code_challenge_method")).toBe("S256");
    expect(login.searchParams.get("resource")).toBe(
      "https://source.example.com/mcp",
    );
    const state = login.searchParams.get("state")!;
    await expect(
      finishServerLogin("another-browser", state, "code"),
    ).rejects.toThrow("different browser");
    await expect(
      finishServerLogin(
        group.browserHash,
        state,
        "code",
        "https://wrong.example.com",
      ),
    ).rejects.toThrow("origin");
    await finishServerLogin(
      group.browserHash,
      state,
      "code",
      "https://source.example.com",
    );
    const tokenCall = network.json.mock.calls.find(
      (c) => c[1] === "/oauth/token",
    )!;
    expect(digest(tokenCall[2].get("code_verifier"))).toBe(
      login.searchParams.get("code_challenge"),
    );
    expect(
      await pluginTransaction((s) => requireGroup(s, group.id).servers.length),
    ).toBe(1);
    await expect(
      finishServerLogin(group.browserHash, state, "code"),
    ).rejects.toThrow("expired");
  });
  it("connects two servers and routes each using its own credentials", async () => {
    await upstream();
    const { group } = await createGroup(authorization);
    const a = remote();
    const b = {
      ...remote(),
      origin: "https://second.example.com",
      accessToken: "second-access",
      label: "Staging",
    };
    await pluginTransaction((s) => {
      requireGroup(s, group.id).servers.push(a, b);
    });
    const { client } = await gateway(group.id);
    const list = await client.callTool({
      name: "panelavo_connected_servers",
      arguments: {},
    });
    expect(list.structuredContent).toMatchObject({
      servers: expect.any(Array),
    });
    expect(
      (list.structuredContent as { servers: unknown[] }).servers,
    ).toHaveLength(2);
    const calls = network.fetch.mock.calls.map(
      ([input, init]) => new Request(input, init),
    );
    expect(
      calls.some(
        (r) =>
          r.url.startsWith(b.origin) &&
          r.headers.get("authorization") === "Bearer second-access",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (r) =>
          r.url.startsWith(a.origin) &&
          r.headers.get("authorization") === `Bearer ${a.accessToken}`,
      ),
    ).toBe(true);
  });
  it("blocks writes through read-only routing and forwards confirmations without accepting them", async () => {
    const writes = await upstream();
    const { group } = await createGroup(authorization);
    const source = remote();
    await pluginTransaction((s) => {
      requireGroup(s, group.id).servers.push(source);
    });
    const args = {
      serverId: source.id,
      tool: "panelavo_write",
      arguments: { filename: "sample.txt" },
    };
    const declined = await gateway(group.id);
    expect(
      (
        await declined.client.callTool({
          name: "panelavo_read_server",
          arguments: args,
        })
      ).isError,
    ).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    await declined.client.callTool({
      name: "panelavo_change_server",
      arguments: args,
    });
    expect(declined.prompt).toHaveBeenCalledOnce();
    expect(writes).not.toHaveBeenCalled();
    const accepted = await gateway(group.id, true);
    expect(
      (
        await accepted.client.callTool({
          name: "panelavo_change_server",
          arguments: args,
        })
      ).isError,
    ).not.toBe(true);
    expect(writes).toHaveBeenCalledExactlyOnceWith("sample.txt");
  });
  it("labels accounts with server IPs and preserves opaque profile IDs across reconnect, rename, token and role changes", async () => {
    const account = identity();
    await upstream(account);
    const { group, cookie } = await createGroup(authorization);
    await pluginTransaction((s) =>
      requireGroup(s, group.id).servers.push(remote()),
    );
    const { client } = await gateway(group.id);
    const declaration = (await client.listTools()).tools.find(
      (t) => t.name === "panelavo_get_profile",
    );
    expect(declaration?._meta?.["openai/profile"]).toBe(true);
    expect(declaration?.annotations?.readOnlyHint).toBe(true);
    expect(declaration?.outputSchema?.required).toContain("id");
    const first = await client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      id: expect.stringMatching(/^prf_/),
      nickname: "203.0.113.10 · Alice",
    });
    await pluginTransaction((s) => {
      delete requireGroup(s, group.id).authorization;
    });
    const html = await (
      await pluginHttp(req("/connect", undefined, cookie))
    ).text();
    expect(html).toContain("Production · 203.0.113.10");
    expect(html).toContain("Read-only");
    account.displayName = "Renamed";
    account.username = "renamed";
    account.role = "admin";
    account.capabilities.manageWebsites = true;
    account.capabilities.createWebsites = true;
    const reconnect = await createGroup(authorization);
    await pluginTransaction((s) => {
      s.groups = s.groups.filter((g) => g.id !== group.id);
      requireGroup(s, reconnect.group.id).servers.push({
        ...remote(),
        label: "Renamed server",
        accessToken: "different-token",
      });
    });
    const next = await gateway(reconnect.group.id);
    const second = await next.client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    expect(data(second).id).toBe(data(first).id);
    expect(data(second).nickname).toBe("203.0.113.10 · Renamed");
    const list = await next.client.callTool({
      name: "panelavo_connected_servers",
      arguments: {},
    });
    expect(data(list).servers).toMatchObject([
      {
        serverIp: "203.0.113.10",
        identity: {
          capabilities: { manageWebsites: true, createWebsites: true },
        },
      },
    ]);
    account.id = "43";
    const different = await next.client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    expect(data(different).id).not.toBe(data(first).id);
  });
  it("identifies the full server-account set independent of connection order", async () => {
    await upstream();
    const one = await createGroup(authorization);
    const two = await createGroup(authorization);
    const firstServer = remote();
    const secondServer = { ...remote(), origin: "https://second.example.com" };
    await pluginTransaction((s) => {
      requireGroup(s, one.group.id).servers.push(firstServer, secondServer);
      requireGroup(s, two.group.id).servers.push(
        { ...secondServer, id: randomUUID() },
        { ...firstServer, id: randomUUID() },
      );
    });
    const a = await gateway(one.group.id);
    const b = await gateway(two.group.id);
    const first = await a.client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    const second = await b.client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    expect(first.isError).not.toBe(true);
    expect(data(first).id).toBe(data(second).id);
    network.json.mockResolvedValue({});
    await disconnectServer(
      two.group.id,
      await pluginTransaction(
        (s) => requireGroup(s, two.group.id).servers[0].id,
      ),
    );
    const subset = await b.client.callTool({
      name: "panelavo_get_profile",
      arguments: {},
    });
    expect(data(subset).id).not.toBe(data(first).id);
  });
  it("does not invent profiles for unauthenticated, empty or outdated connections, or treat a hostname as an IP", async () => {
    const account: Record<string, unknown> = identity();
    await upstream(account);
    const { group } = await createGroup(authorization);
    const { client } = await gateway(group.id);
    const call = () =>
      client.callTool({ name: "panelavo_get_profile", arguments: {} });
    expect((await call()).isError).toBe(true);
    await pluginTransaction((s) =>
      requireGroup(s, group.id).servers.push(remote()),
    );
    account.serverIp = "server.example.com";
    expect(data(await call()).nickname).toBe("source.example.com · Alice");
    const list = await client.callTool({
      name: "panelavo_connected_servers",
      arguments: {},
    });
    expect(data(list).servers).toMatchObject([{ serverIp: null }]);
    delete account.id;
    expect((await call()).isError).toBe(true);
    account.id = "42";
    network.fetch.mockRejectedValue(new Error("Expired authentication"));
    expect((await call()).isError).toBe(true);
  });
  it("coalesces concurrent refreshes and erases credentials even when revocation is offline", async () => {
    const { group } = await createGroup(authorization);
    const source = { ...remote(), expiresAt: Date.now() - 1 };
    await pluginTransaction((s) => {
      requireGroup(s, group.id).servers.push(source);
    });
    network.json.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return tokenReply();
    });
    const results = await Promise.all([
      serverCredentials(group.id, source.id),
      serverCredentials(group.id, source.id),
    ]);
    expect(network.json).toHaveBeenCalledOnce();
    expect(results.every((r) => r.refreshToken === "new-refresh-secret")).toBe(
      true,
    );
    network.json.mockRejectedValue(new Error("Offline"));
    await disconnectServer(group.id, source.id);
    await expect(serverCredentials(group.id, source.id)).rejects.toThrow(
      "not connected",
    );
  });
  it("rejects CSRF and disables the connection service unless explicitly enabled", async () => {
    const { group, cookie } = await createGroup(authorization);
    const body = new URLSearchParams({ csrf: group.csrf });
    expect(
      (
        await pluginHttp(
          req("/connect/disconnect", body, cookie, "https://evil.example.com"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await pluginHttp(
          req(
            "/connect/disconnect",
            new URLSearchParams({ csrf: "wrong" }),
            cookie,
          ),
        )
      ).status,
    ).toBe(403);
    expect((await browserGroup(cookie))?.id).toBe(group.id);
    vi.stubEnv("PANELAVO_PLUGIN_ENABLED", "0");
    expect((await pluginHttp(req("/connect"))).status).toBe(404);
  });
  it("keeps gateway tokens separate from local users and rejects deleted connection groups", async () => {
    const urls = pluginUrls(req("/connect"));
    const client = await registerMcpOAuthClient({
      client_name: "Test",
      redirect_uris: ["http://127.0.0.1:3210/callback"],
    });
    const verifier = "v".repeat(64);
    const authorization = await validateMcpAuthorizationRequest(
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        scope: "panelavo:access",
        resource: urls.resource,
        code_challenge: digest(verifier),
        code_challenge_method: "S256",
      }),
      urls,
    );
    const { group } = await createGroup(authorization);
    const subject = groupSubject(group);
    const consent = await createMcpConsent(authorization, subject);
    const redirect = new URL(
      await completeMcpAuthorization(consent.token, "approve", subject),
    );
    const tokens = await exchangeMcpOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
        resource: urls.resource,
      }),
      urls,
    );
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
    const pluginVerifier = createMcpTokenVerifier({
      resource: urls.resource,
      resolve: async (id) => {
        await pluginTransaction((s) => requireGroup(s, id));
      },
    });
    expect(
      (await pluginVerifier.verifyAccessToken(tokens.access_token)).extra
        ?.panelavoConnectionGroup,
    ).toBe(group.id);
    const personal = await createMcpPersonalToken(
      "42",
      "alice",
      { name: "Personal", expiresInDays: 30 },
      getMcpPublicUrls(req("/mcp")),
    );
    await expect(
      pluginVerifier.verifyAccessToken(personal.token),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await pluginTransaction((s) => {
      s.groups = [];
    });
    await expect(
      pluginVerifier.verifyAccessToken(tokens.access_token),
    ).rejects.toThrow("expired");
  });
});
