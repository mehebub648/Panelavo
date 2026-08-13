import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import {
  clearMcpConfirmationStoreForTests,
  createMcpConfirmationManager,
} from "./confirmation";

const actor: PanelActor = {
  user: {
    id: "42",
    username: "alice",
    panelRole: "admin",
    canCreateSites: true,
  },
  cloudPanel: {
    cookies: {},
    usernameHint: "alice",
    cliAuthenticated: true,
  },
  authentication: "mcp",
  credentialId: "grant-1",
};

type ConfirmationState = {
  version: 1;
  tool: string;
  argumentsDigest: string;
  nonce: string;
  expiresAt: number;
};

function context({
  inputResponses,
  requestState,
  clientId = "client-a",
}: {
  inputResponses?: Record<string, unknown>;
  requestState?: unknown;
  clientId?: string;
} = {}) {
  return {
    mcpReq: {
      method: "tools/call",
      inputResponses,
      requestState: <T>() => requestState as T | undefined,
    },
    http: {
      authInfo: {
        token: "redacted",
        clientId,
        scopes: ["panelavo:access"],
      },
    },
  } as unknown as ServerContext;
}

function acceptedContext(
  state: ConfirmationState,
  confirmation?: string,
  clientId = "client-a",
) {
  return context({
    requestState: state,
    clientId,
    inputResponses: {
      panelavo_confirmation: {
        action: "accept",
        content: { confirm: true, confirmation },
      },
    },
  });
}

async function beginConfirmation(
  manager: ReturnType<typeof createMcpConfirmationManager>,
  tool: string,
  argumentsValue: unknown,
  confirmationPhrase?: string,
) {
  const result = await manager.require({
    context: context(),
    tool,
    arguments: argumentsValue,
    message: "Allow this website action?",
    confirmationPhrase,
  });
  expect(result).toMatchObject({
    resultType: "input_required",
    inputRequests: {
      panelavo_confirmation: { method: "elicitation/create" },
    },
  });
  if (!result || typeof result.requestState !== "string")
    throw new Error("Expected a signed request state.");
  const state = (await manager.verifyRequestState(
    result.requestState,
    context(),
  )) as ConfirmationState;
  return { requestState: result.requestState, state, result };
}

describe("MCP website action confirmation", () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "panelavo-mcp-confirmation-"));
    process.env.PANEL_DATA_DIR = dataDirectory;
    process.env.SESSION_SECRET = "test-mcp-confirmation-secret-32-characters";
    await clearMcpConfirmationStoreForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("returns an elicitation with HMAC-authenticated state", async () => {
    const manager = createMcpConfirmationManager(actor);
    const { state } = await beginConfirmation(manager, "panelavo_deploy_site", {
      domain: "example.com",
      plan: "node",
    });

    expect(state).toMatchObject({
      version: 1,
      tool: "panelavo_deploy_site",
    });
    expect(state.argumentsDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.nonce).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects a confirmation replayed for another tool", async () => {
    const manager = createMcpConfirmationManager(actor);
    const { state } = await beginConfirmation(manager, "panelavo_deploy_site", {
      domain: "example.com",
      plan: "node",
    });

    await expect(
      manager.require({
        context: acceptedContext(state),
        tool: "panelavo_execute_terminal_command",
        arguments: { domain: "example.com", command: "id" },
        message: "Run this command?",
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it("rejects a confirmation replayed against another website", async () => {
    const manager = createMcpConfirmationManager(actor);
    const { state } = await beginConfirmation(manager, "panelavo_deploy_site", {
      domain: "one.example",
      plan: "node",
    });

    await expect(
      manager.require({
        context: acceptedContext(state),
        tool: "panelavo_deploy_site",
        arguments: { domain: "two.example", plan: "node" },
        message: "Deploy this website?",
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it("rejects expired signed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const manager = createMcpConfirmationManager(actor);
    const { requestState } = await beginConfirmation(
      manager,
      "panelavo_deploy_site",
      { domain: "example.com", plan: "node" },
    );

    vi.advanceTimersByTime(121_000);
    await expect(
      manager.verifyRequestState(requestState, context()),
    ).rejects.toThrow(/expired/i);
  });

  it("consumes an accepted confirmation exactly once", async () => {
    const manager = createMcpConfirmationManager(actor);
    const argumentsValue = { domain: "example.com", plan: "node" };
    const { state } = await beginConfirmation(
      manager,
      "panelavo_deploy_site",
      argumentsValue,
    );
    const request = {
      context: acceptedContext(state),
      tool: "panelavo_deploy_site",
      arguments: argumentsValue,
      message: "Deploy this website?",
    };

    await expect(manager.require(request)).resolves.toBeUndefined();
    await expect(manager.require(request)).rejects.toThrow(
      /expired or was already used/i,
    );
  });

  it("binds deletion approval to the exact action, domain, and phrase", async () => {
    const manager = createMcpConfirmationManager(actor);
    const argumentsValue = { action: "delete", domain: "example.com" };
    const { state } = await beginConfirmation(
      manager,
      "panelavo_delete_site",
      argumentsValue,
      "example.com",
    );

    await expect(
      manager.require({
        context: acceptedContext(state, "other.example"),
        tool: "panelavo_delete_site",
        arguments: argumentsValue,
        message: "Delete this website?",
        confirmationPhrase: "example.com",
      }),
    ).rejects.toThrow(/not confirmed correctly/i);
    await expect(
      manager.require({
        context: acceptedContext(state, "example.com"),
        tool: "panelavo_delete_site",
        arguments: argumentsValue,
        message: "Delete this website?",
        confirmationPhrase: "example.com",
      }),
    ).resolves.toBeUndefined();
  });

  it("labels an exact-value confirmation without assuming website deletion", async () => {
    const manager = createMcpConfirmationManager(actor);
    const { result } = await beginConfirmation(
      manager,
      "panelavo_manage_offsite_backup",
      { domain: "example.com", action: "delete", backupId: "backup-42" },
      "backup-42",
    );

    const confirmation = result as unknown as {
      inputRequests: {
        panelavo_confirmation: {
          params: {
            requestedSchema: {
              properties: { confirmation: Record<string, unknown> };
            };
          };
        };
      };
    };
    expect(
      confirmation.inputRequests.panelavo_confirmation.params.requestedSchema
        .properties.confirmation,
    ).toMatchObject({
      title: "Type backup-42 exactly",
      description: "Type the exact value shown above to confirm this action.",
    });
  });

  it("binds signed state to the OAuth client and MCP credential", async () => {
    const manager = createMcpConfirmationManager(actor);
    const { requestState } = await beginConfirmation(
      manager,
      "panelavo_deploy_site",
      { domain: "example.com", plan: "node" },
    );

    await expect(
      manager.verifyRequestState(
        requestState,
        context({ clientId: "client-b" }),
      ),
    ).rejects.toThrow(/bind/i);
    const otherCredential = createMcpConfirmationManager({
      ...actor,
      credentialId: "grant-2",
    });
    await expect(
      otherCredential.verifyRequestState(requestState, context()),
    ).rejects.toThrow(/bind/i);
  });
});
