import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type ListToolsResult,
  type McpServer,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import type { PanelRole } from "@/types/cloudpanel";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  getServerPublicIp: vi.fn(),
  getSiteDomainsForActor: vi.fn(),
  getSiteDnsForActor: vi.fn(),
  listLinkedServicesForActor: vi.fn(),
  getSiteUptimeForActor: vi.fn(),
  getSiteDeployHooksForActor: vi.fn(),
  getSiteBackupAutomationForActor: vi.fn(),
  getCloudPanelClient: vi.fn(),
}));

vi.mock("@/server/security/log", () => ({
  audit: mocks.audit,
  auditContext: (value: unknown) => value,
}));
vi.mock("@/server/network/server-ip", () => ({
  getServerPublicIp: mocks.getServerPublicIp,
}));
vi.mock("@/server/sites/site-domain-service", () => ({
  getSiteDomainsForActor: mocks.getSiteDomainsForActor,
  getSiteDnsForActor: mocks.getSiteDnsForActor,
  manageSiteDomainsForActor: vi.fn(),
  pointSiteDnsForActor: vi.fn(),
}));
vi.mock("@/server/sites/linked-service-service", () => ({
  createLinkedServiceForActor: vi.fn(),
  listLinkedServicesForActor: mocks.listLinkedServicesForActor,
}));
vi.mock("@/server/sites/site-automation-service", () => ({
  getSiteBackupAutomationForActor: mocks.getSiteBackupAutomationForActor,
  getSiteDeployHooksForActor: mocks.getSiteDeployHooksForActor,
  getSiteUptimeForActor: mocks.getSiteUptimeForActor,
  manageSiteOffsiteBackupForActor: vi.fn(),
  removeSiteOffsiteDestinationForActor: vi.fn(),
  saveSiteBackupScheduleForActor: vi.fn(),
  saveSiteDeployHooksForActor: vi.fn(),
  saveSiteOffsiteDestinationForActor: vi.fn(),
  saveSiteUptimeForActor: vi.fn(),
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: mocks.getCloudPanelClient,
}));

import { createPanelavoMcpServer } from "./server";

const READ_TOOLS = [
  "panelavo_get_site",
  "panelavo_get_site_dns",
  "panelavo_get_site_domains",
  "panelavo_get_site_section",
  "panelavo_get_site_uptime",
  "panelavo_list_linked_services",
  "panelavo_list_sites",
  "panelavo_whoami",
];

const CREATE_TOOLS = [
  "panelavo_create_site",
  "panelavo_get_site_creation_options",
];

const WRITE_TOOLS = [
  "panelavo_begin_artifact_upload",
  "panelavo_cancel_site_job",
  "panelavo_configure_backup_schedule",
  "panelavo_configure_deploy_hooks",
  "panelavo_configure_offsite_backup",
  "panelavo_configure_site_uptime",
  "panelavo_create_backup",
  "panelavo_create_linked_service",
  "panelavo_delete_artifact_upload",
  "panelavo_deploy_artifact_release",
  "panelavo_delete_site",
  "panelavo_deploy_site",
  "panelavo_execute_terminal_command",
  "panelavo_get_artifact_upload",
  "panelavo_get_site_job",
  "panelavo_get_site_automation",
  "panelavo_manage_offsite_backup",
  "panelavo_manage_site_domains",
  "panelavo_manage_site_section",
  "panelavo_list_site_jobs",
  "panelavo_list_site_releases",
  "panelavo_point_site_dns",
  "panelavo_run_site_operation",
  "panelavo_rollback_site_release",
  "panelavo_start_site_job",
  "panelavo_update_site",
];

const SERVER_TOOLS = [
  "panelavo_get_server_information",
  "panelavo_get_server_resources",
];

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: unknown };

function actor(role: PanelRole): PanelActor {
  return {
    user: {
      id: `user-${role}`,
      username: role,
      panelRole: role,
      canCreateSites: role !== "user",
    },
    cloudPanel: { cookies: {}, usernameHint: role },
    authentication: "mcp",
    credentialId: `grant-${role}`,
  };
}

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let requestId = 0;
  const pending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }
  >();

  clientTransport.onmessage = (message) => {
    if (!("id" in message) || message.id === null) return;
    if (!("result" in message) && !("error" in message)) return;
    const response = message as JsonRpcResponse;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if ("error" in response) waiter.reject(response.error);
    else waiter.resolve(response.result);
  };

  await clientTransport.start();
  await server.connect(serverTransport);

  async function request<T>(method: string, params?: Record<string, unknown>) {
    const id = ++requestId;
    const response = new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    await clientTransport.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    });
    return response;
  }

  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Panelavo surface test", version: "1.0.0" },
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  return {
    listTools: () => request<ListToolsResult>("tools/list", {}),
    callTool: (name: string, argumentsValue: Record<string, unknown>) =>
      request<CallToolResult>("tools/call", {
        name,
        arguments: argumentsValue,
      }),
    close: () => server.close(),
  };
}

function toolNames(list: ListToolsResult) {
  return list.tools.map((tool) => tool.name).sort();
}

function tool(list: ListToolsResult, name: string) {
  const found = list.tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Expected MCP tool ${name}.`);
  return found;
}

describe("MCP role-aware tool surface", () => {
  const connected: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(undefined);
    mocks.getServerPublicIp.mockResolvedValue("203.0.113.10");
    mocks.getCloudPanelClient.mockReturnValue({
      getServerInfo: vi.fn(),
      getServerResources: vi.fn(),
    });
  });

  afterEach(async () => {
    await Promise.all(connected.splice(0).map((client) => client.close()));
  });

  async function toolsFor(role: PanelRole) {
    const client = await connect(createPanelavoMcpServer(actor(role)));
    connected.push(client);
    return client.listTools();
  }

  it.each([
    ["user", READ_TOOLS],
    ["admin", [...READ_TOOLS, ...CREATE_TOOLS, ...WRITE_TOOLS]],
    [
      "manager",
      [...READ_TOOLS, ...CREATE_TOOLS, ...WRITE_TOOLS, ...SERVER_TOOLS],
    ],
    [
      "super-admin",
      [...READ_TOOLS, ...CREATE_TOOLS, ...WRITE_TOOLS, ...SERVER_TOOLS],
    ],
  ] satisfies Array<[PanelRole, string[]]>)(
    "lists only the live %s role's effective tools",
    async (role, expected) => {
      expect(toolNames(await toolsFor(role))).toEqual(expected.sort());
    },
  );

  it("keeps domain orchestration dedicated and hides raw domain sections", async () => {
    const userTools = await toolsFor("user");
    const adminTools = await toolsFor("admin");

    expect(toolNames(userTools)).toEqual(
      expect.arrayContaining([
        "panelavo_get_site_domains",
        "panelavo_get_site_dns",
      ]),
    );
    expect(toolNames(userTools)).not.toEqual(
      expect.arrayContaining([
        "panelavo_manage_site_domains",
        "panelavo_point_site_dns",
      ]),
    );
    expect(toolNames(adminTools)).toEqual(
      expect.arrayContaining([
        "panelavo_manage_site_domains",
        "panelavo_point_site_dns",
      ]),
    );

    const readSection = tool(userTools, "panelavo_get_site_section");
    const writeSection = tool(adminTools, "panelavo_manage_site_section");
    expect(
      (readSection.inputSchema.properties?.section as { enum?: string[] }).enum,
    ).not.toContain("domains");
    expect(JSON.stringify(writeSection.inputSchema)).not.toContain(
      '"const":"domains"',
    );
  });

  it("publishes uptime and backup automation according to website-write access", async () => {
    const userTools = await toolsFor("user");
    const adminTools = await toolsFor("admin");
    const automationMutations = [
      "panelavo_configure_site_uptime",
      "panelavo_configure_deploy_hooks",
      "panelavo_configure_backup_schedule",
      "panelavo_configure_offsite_backup",
      "panelavo_manage_offsite_backup",
    ];

    expect(toolNames(userTools)).toContain("panelavo_get_site_uptime");
    expect(toolNames(userTools)).not.toContain("panelavo_get_site_automation");
    for (const name of automationMutations)
      expect(toolNames(userTools)).not.toContain(name);

    expect(toolNames(adminTools)).toEqual(
      expect.arrayContaining([
        "panelavo_get_site_uptime",
        "panelavo_get_site_automation",
        ...automationMutations,
      ]),
    );
    expect(
      tool(adminTools, "panelavo_configure_deploy_hooks").annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(
      tool(adminTools, "panelavo_configure_backup_schedule").annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(
      tool(adminTools, "panelavo_manage_offsite_backup").annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});

describe("MCP in-memory tool delegation", () => {
  const connected: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(undefined);
    mocks.getServerPublicIp.mockResolvedValue("203.0.113.10");
    mocks.getSiteDomainsForActor.mockResolvedValue({
      meta: { aliases: ["www.example.test"], block: "none" },
      serverIp: "203.0.113.10",
      dns: [],
    });
    mocks.getSiteDnsForActor.mockResolvedValue({
      pointed: true,
      ip: "203.0.113.10",
      serverIp: "203.0.113.10",
      zoneId: "zone-1",
      credentialId: "credential-1",
    });
    mocks.getSiteUptimeForActor.mockResolvedValue({
      config: { enabled: true, intervalMinutes: 5 },
      state: { status: "up" },
    });
    mocks.getSiteDeployHooksForActor.mockResolvedValue({
      hooks: [{ command: "npm-install" }],
    });
    mocks.getSiteBackupAutomationForActor.mockResolvedValue({
      schedule: { enabled: true, frequency: "daily" },
      destination: null,
      remoteBackups: [],
    });
  });

  afterEach(async () => {
    await Promise.all(connected.splice(0).map((client) => client.close()));
  });

  it("invokes dedicated domain, DNS, and uptime reads through shared services", async () => {
    const panelActor = actor("user");
    const client = await connect(createPanelavoMcpServer(panelActor));
    connected.push(client);

    await expect(
      client.callTool("panelavo_get_site_domains", {
        domain: "site.example.test",
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        meta: { aliases: ["www.example.test"] },
        serverIp: "203.0.113.10",
      },
    });
    await expect(
      client.callTool("panelavo_get_site_dns", {
        domain: "www.example.test",
      }),
    ).resolves.toMatchObject({
      structuredContent: { pointed: true, zoneId: "zone-1" },
    });
    await expect(
      client.callTool("panelavo_get_site_uptime", {
        domain: "site.example.test",
      }),
    ).resolves.toMatchObject({
      structuredContent: { state: { status: "up" } },
    });

    expect(mocks.getSiteDomainsForActor).toHaveBeenCalledWith(
      panelActor,
      "site.example.test",
      "203.0.113.10",
    );
    expect(mocks.getSiteDnsForActor).toHaveBeenCalledWith(
      panelActor,
      "www.example.test",
      "203.0.113.10",
    );
    expect(mocks.getSiteUptimeForActor).toHaveBeenCalledWith(
      panelActor,
      "site.example.test",
    );
  });

  it("combines deploy-hook and backup automation reads for a writer", async () => {
    const panelActor = actor("admin");
    const client = await connect(createPanelavoMcpServer(panelActor));
    connected.push(client);

    await expect(
      client.callTool("panelavo_get_site_automation", {
        domain: "site.example.test",
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        deployHooks: { hooks: [{ command: "npm-install" }] },
        backups: {
          schedule: { enabled: true, frequency: "daily" },
          remoteBackups: [],
        },
      },
    });
    expect(mocks.getSiteDeployHooksForActor).toHaveBeenCalledWith(
      panelActor,
      "site.example.test",
    );
    expect(mocks.getSiteBackupAutomationForActor).toHaveBeenCalledWith(
      panelActor,
      "site.example.test",
    );
  });
});
