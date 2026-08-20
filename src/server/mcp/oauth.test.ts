import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPanelUser } from "@/types/cloudpanel";

const cloudPanelMock = vi.hoisted(() => ({
  user: {
    id: "42",
    username: "alice",
    canCreateSites: false,
    panelRole: "user",
    status: true,
  } as CloudPanelUser,
}));

vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    getCurrentUser: vi.fn(async () => cloudPanelMock.user),
  }),
}));

import {
  clearMcpOAuthStoreForTests,
  completeMcpAuthorization,
  createMcpConsent,
  createMcpPersonalToken,
  exchangeMcpOAuthToken,
  listMcpConnections,
  mcpTokenVerifier,
  normalizeMcpAuthorizeReturnTo,
  registerMcpOAuthClient,
  revokeAllMcpConnections,
  revokeMcpConnection,
  validateMcpAuthorizationRequest,
} from "./oauth";
import { getMcpPublicUrlsFromHeaders } from "./public-url";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("MCP authentication", () => {
  let directory: string;
  const urls = getMcpPublicUrlsFromHeaders(
    new Headers({ host: "localhost:10443" }),
  );

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-mcp-oauth-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.SESSION_SECRET =
      "test-session-secret-with-at-least-32-characters";
    cloudPanelMock.user = {
      id: "42",
      username: "alice",
      canCreateSites: false,
      panelRole: "user",
      status: true,
    };
    await clearMcpOAuthStoreForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(directory, { recursive: true, force: true });
  });

  async function authorizedClient() {
    const client = await registerMcpOAuthClient({
      client_name: "Codex",
      redirect_uris: ["http://127.0.0.1:3210/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      scope: "panelavo:access",
      resource: urls.resource,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-value",
    });
    const authorization = await validateMcpAuthorizationRequest(params, urls);
    const consent = await createMcpConsent(authorization, cloudPanelMock.user);
    const location = await completeMcpAuthorization(
      consent.token,
      "approve",
      cloudPanelMock.user,
    );
    const code = new URL(location).searchParams.get("code");
    expect(new URL(location).searchParams.get("state")).toBe("state-value");
    expect(code).toBeTruthy();
    return { client, code: code as string, consent };
  }

  async function exchangeCode(clientId: string, code: string) {
    return exchangeMcpOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: "http://127.0.0.1:3210/callback",
        code_verifier: verifier,
        resource: urls.resource,
      }),
      urls,
    );
  }

  it("uses one-use PKCE codes and stores no raw OAuth credential", async () => {
    const { client, code, consent } = await authorizedClient();
    const tokens = await exchangeCode(client.client_id, code);
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      scope: "panelavo:access",
    });
    await expect(exchangeCode(client.client_id, code)).rejects.toMatchObject({
      code: "invalid_grant",
    });

    const stored = await readFile(join(directory, "mcp-oauth.json"), "utf8");
    expect(stored).not.toContain(consent.token);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
  });

  it("issues a revocable personal MCP token without storing its secret", async () => {
    const created = await createMcpPersonalToken(
      "42",
      "alice",
      { name: "Alice laptop", expiresInDays: 90 },
      urls,
    );

    expect(created.token).toMatch(/^pnl_mpat\./);
    expect(
      await readFile(join(directory, "mcp-oauth.json"), "utf8"),
    ).not.toContain(created.token);
    await expect(listMcpConnections("42", "alice")).resolves.toMatchObject([
      {
        id: created.connection.id,
        clientName: "Alice laptop",
        kind: "personal-token",
      },
    ]);

    await expect(
      mcpTokenVerifier.verifyAccessToken(created.token),
    ).resolves.toMatchObject({
      clientId: created.connection.clientId,
      scopes: ["panelavo:access"],
      extra: {
        panelavoActor: {
          authentication: "mcp",
          credentialId: created.connection.id,
        },
      },
    });

    await revokeMcpConnection("42", "alice", created.connection.id);
    await expect(
      mcpTokenVerifier.verifyAccessToken(created.token),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("replaces a repeated pending approval for the same user and client", async () => {
    const client = await registerMcpOAuthClient({
      client_name: "Codex",
      redirect_uris: ["http://127.0.0.1:3210/callback"],
    });
    const authorization = await validateMcpAuthorizationRequest(
      new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: "panelavo:access",
        resource: urls.resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      urls,
    );
    const first = await createMcpConsent(authorization, cloudPanelMock.user);
    const second = await createMcpConsent(authorization, cloudPanelMock.user);
    expect(second.redirectHost).toBe("127.0.0.1:3210");
    await expect(
      completeMcpAuthorization(first.token, "approve", cloudPanelMock.user),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      completeMcpAuthorization(second.token, "deny", cloudPanelMock.user),
    ).resolves.toContain("error=access_denied");
    const auditLog = await readFile(
      join(directory, "audit", "audit.jsonl"),
      "utf8",
    );
    expect(auditLog).toContain('"action":"mcp.oauth.grant"');
    expect(auditLog).toContain('"decision":"deny"');
    expect(auditLog).not.toContain(second.token);
  });

  it("extends an existing connection when the user authorizes it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    const { client } = await authorizedClient();
    const [before] = await listMcpConnections("42", "alice");

    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    const authorization = await validateMcpAuthorizationRequest(
      new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: "panelavo:access",
        resource: urls.resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      urls,
    );
    const consent = await createMcpConsent(authorization, cloudPanelMock.user);
    await completeMcpAuthorization(
      consent.token,
      "approve",
      cloudPanelMock.user,
    );
    const [after] = await listMcpConnections("42", "alice");
    expect(after.id).toBe(before.id);
    expect(after.expiresAt).toBe((before.expiresAt ?? 0) + 24 * 60 * 60 * 1000);
  });

  it("rotates refresh tokens and revokes the family when an old token is replayed", async () => {
    const { client, code } = await authorizedClient();
    const first = await exchangeCode(client.client_id, code);
    const second = await exchangeMcpOAuthToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: first.refresh_token,
        resource: urls.resource,
      }),
      urls,
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const rotatedStore = JSON.parse(
      await readFile(join(directory, "mcp-oauth.json"), "utf8"),
    ) as {
      refreshTokens: unknown[];
      refreshFamilies: Array<{ usedTokenHashes: string[] }>;
    };
    expect(rotatedStore.refreshTokens).toHaveLength(1);
    expect(rotatedStore.refreshFamilies).toHaveLength(1);
    expect(rotatedStore.refreshFamilies[0].usedTokenHashes).toHaveLength(1);
    expect(rotatedStore.refreshFamilies[0].usedTokenHashes[0]).not.toContain(
      first.refresh_token,
    );
    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: first.refresh_token,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      mcpTokenVerifier.verifyAccessToken(second.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
    const auditLog = await readFile(
      join(directory, "audit", "audit.jsonl"),
      "utf8",
    );
    expect(auditLog).toContain('"action":"mcp.oauth.refresh_replay"');
    expect(auditLog).not.toContain(first.refresh_token);
  });

  it("never revokes another client or a family for an unauthenticated replay value", async () => {
    const firstClient = await authorizedClient();
    const firstTokens = await exchangeCode(
      firstClient.client.client_id,
      firstClient.code,
    );
    const rotated = await exchangeMcpOAuthToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: firstClient.client.client_id,
        refresh_token: firstTokens.refresh_token,
        resource: urls.resource,
      }),
      urls,
    );

    const secondClient = await authorizedClient();
    const secondTokens = await exchangeCode(
      secondClient.client.client_id,
      secondClient.code,
    );
    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: secondClient.client.client_id,
          refresh_token: firstTokens.refresh_token,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const parts = firstTokens.refresh_token.split(".");
    const randomTargetedToken = [
      parts[0],
      parts[1],
      "00000000-0000-4000-8000-000000000000",
      "a".repeat(43),
    ].join(".");
    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: firstClient.client.client_id,
          refresh_token: randomTargetedToken,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    await expect(
      mcpTokenVerifier.verifyAccessToken(rotated.access_token),
    ).resolves.toMatchObject({ clientId: firstClient.client.client_id });
    await expect(
      mcpTokenVerifier.verifyAccessToken(secondTokens.access_token),
    ).resolves.toMatchObject({ clientId: secondClient.client.client_id });

    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: firstClient.client.client_id,
          refresh_token: firstTokens.refresh_token,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      mcpTokenVerifier.verifyAccessToken(rotated.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      mcpTokenVerifier.verifyAccessToken(secondTokens.access_token),
    ).resolves.toMatchObject({ clientId: secondClient.client.client_id });
  });

  it("throttles rapid refresh rotation without growing token tombstones", async () => {
    const { client, code } = await authorizedClient();
    let tokens = await exchangeCode(client.client_id, code);
    for (let index = 0; index < 12; index += 1) {
      tokens = await exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: urls.resource,
        }),
        urls,
      );
    }
    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "too_many_requests", status: 429 });
    const stored = JSON.parse(
      await readFile(join(directory, "mcp-oauth.json"), "utf8"),
    ) as { refreshTokens: unknown[]; refreshFamilies: unknown[] };
    expect(stored.refreshTokens).toHaveLength(1);
    expect(stored.refreshFamilies).toHaveLength(1);
  });

  it("fails closed for malformed persisted refresh quota counters", async () => {
    const { client, code } = await authorizedClient();
    const tokens = await exchangeCode(client.client_id, code);
    const storePath = join(directory, "mcp-oauth.json");
    const seeded = JSON.parse(await readFile(storePath, "utf8")) as {
      grants: Array<{
        refreshBurstStartedAt?: number;
        refreshBurstCount?: unknown;
      }>;
    };
    seeded.grants[0].refreshBurstStartedAt = Date.now();
    seeded.grants[0].refreshBurstCount = "corrupt";
    await writeFile(storePath, JSON.stringify(seeded));

    await expect(
      exchangeMcpOAuthToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: urls.resource,
        }),
        urls,
      ),
    ).rejects.toMatchObject({ code: "too_many_requests", status: 429 });
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).resolves.toMatchObject({ clientId: client.client_id });
  });

  it("keeps exact refresh replay tombstones within the per-family cap", async () => {
    const { client, code } = await authorizedClient();
    const tokens = await exchangeCode(client.client_id, code);
    const storePath = join(directory, "mcp-oauth.json");
    const seeded = JSON.parse(await readFile(storePath, "utf8")) as {
      refreshFamilies: Array<{ usedTokenHashes: string[] }>;
    };
    const tombstone = (index: number) => index.toString(36).padStart(43, "0");
    seeded.refreshFamilies[0].usedTokenHashes = Array.from(
      { length: 6201 },
      (_, index) => tombstone(index),
    );
    seeded.refreshFamilies[0].usedTokenHashes.push("not-a-valid-hmac");
    await writeFile(storePath, JSON.stringify(seeded));

    await exchangeMcpOAuthToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: urls.resource,
      }),
      urls,
    );
    const stored = JSON.parse(await readFile(storePath, "utf8")) as {
      refreshFamilies: Array<{ usedTokenHashes: string[] }>;
    };
    expect(stored.refreshFamilies[0].usedTokenHashes).toHaveLength(6200);
    expect(stored.refreshFamilies[0].usedTokenHashes).not.toContain(
      tombstone(0),
    );
    expect(stored.refreshFamilies[0].usedTokenHashes).not.toContain(
      tombstone(1),
    );
    expect(stored.refreshFamilies[0].usedTokenHashes).toContain(
      tombstone(6200),
    );
    expect(stored.refreshFamilies[0].usedTokenHashes).not.toContain(
      "not-a-valid-hmac",
    );
  });

  it("evicts the oldest unused DCR client when registration is at capacity", async () => {
    const now = Date.now();
    const clients = Array.from({ length: 500 }, (_, index) => ({
      id: `pnl_client_seed_${index}`,
      clientName: `Seed ${index}`,
      redirectUris: [`https://client${index}.example/callback`],
      createdAt: now - 500 + index,
    }));
    await writeFile(
      join(directory, "mcp-oauth.json"),
      JSON.stringify({
        clients,
        authorizationRequests: [],
        grants: [
          {
            id: "seed-grant",
            clientId: "pnl_client_seed_0",
            clientName: "Referenced seed",
            username: "someone",
            userId: "seed-user",
            createdAt: now,
            expiresAt: now + 60_000,
          },
        ],
        authorizationCodes: [],
        accessTokens: [],
        refreshTokens: [],
        refreshFamilies: [],
      }),
    );
    const created = await registerMcpOAuthClient({
      client_name: "New client",
      redirect_uris: ["https://new-client.example/callback"],
    });
    const stored = JSON.parse(
      await readFile(join(directory, "mcp-oauth.json"), "utf8"),
    ) as { clients: Array<{ id: string }> };
    expect(stored.clients).toHaveLength(500);
    expect(
      stored.clients.some((client) => client.id === "pnl_client_seed_0"),
    ).toBe(true);
    expect(
      stored.clients.some((client) => client.id === "pnl_client_seed_1"),
    ).toBe(false);
    expect(
      stored.clients.some((client) => client.id === created.client_id),
    ).toBe(true);
    const auditLog = await readFile(
      join(directory, "audit", "audit.jsonl"),
      "utf8",
    );
    expect(auditLog).toContain('"action":"mcp.oauth.client_registered"');
    expect(auditLog).toContain(created.client_id);
  });

  it("binds bearer access to the stable user id and revokes the visible connection", async () => {
    const { client, code } = await authorizedClient();
    const tokens = await exchangeCode(client.client_id, code);
    const authInfo = await mcpTokenVerifier.verifyAccessToken(
      tokens.access_token,
    );
    expect(authInfo).toMatchObject({
      clientId: client.client_id,
      scopes: ["panelavo:access"],
      resource: new URL(urls.resource),
    });
    const [connection] = await listMcpConnections("42", "alice");
    expect(connection).toMatchObject({
      clientId: client.client_id,
      clientName: "Codex",
    });
    await expect(listMcpConnections("99", "alice")).resolves.toEqual([]);
    await revokeMcpConnection("99", "alice", connection.id);
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).resolves.toMatchObject({ clientId: client.client_id });

    cloudPanelMock.user = { ...cloudPanelMock.user, id: "99" };
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
    cloudPanelMock.user = { ...cloudPanelMock.user, id: "42" };
    await revokeMcpConnection("42", "alice", connection.id);
    await expect(listMcpConnections("42", "alice")).resolves.toEqual([]);
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("revokes every grant only for the exact current account identity", async () => {
    const { client, code } = await authorizedClient();
    const tokens = await exchangeCode(client.client_id, code);
    await revokeAllMcpConnections("99", "alice");
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).resolves.toMatchObject({ clientId: client.client_id });
    await revokeAllMcpConnections("42", "alice");
    await expect(listMcpConnections("42", "alice")).resolves.toEqual([]);
    await expect(
      mcpTokenVerifier.verifyAccessToken(tokens.access_token),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("accepts only local OAuth authorization return paths", () => {
    expect(
      normalizeMcpAuthorizeReturnTo(
        "/oauth/authorize?client_id=pnl_client_test&state=abc",
      ),
    ).toBe("/oauth/authorize?client_id=pnl_client_test&state=abc");
    expect(
      normalizeMcpAuthorizeReturnTo("//evil.example/oauth/authorize"),
    ).toBeUndefined();
    expect(normalizeMcpAuthorizeReturnTo("/sites")).toBeUndefined();
    expect(normalizeMcpAuthorizeReturnTo(["/oauth/authorize"])).toBeUndefined();
  });
});
