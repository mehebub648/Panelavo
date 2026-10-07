import {
  Client,
  StreamableHTTPClientTransport,
  type ElicitRequestParams,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { panelFetch, panelJson } from "./network";
import { pluginTransaction, requireGroup, type PluginServer } from "./store";

export const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86400),
  scope: z.literal("panelavo:access"),
});
const refreshes = new Map<string, Promise<PluginServer>>();

export async function serverCredentials(
  groupId: string,
  serverId: string,
): Promise<PluginServer> {
  const current = await pluginTransaction((s) =>
    requireGroup(s, groupId).servers.find((r) => r.id === serverId),
  );
  if (!current)
    throw new Error(
      "This server is not connected to your plugin. List your servers first.",
    );
  if (current.expiresAt > Date.now() + 30_000) return current;
  const key = `${groupId}:${serverId}`;
  const existing = refreshes.get(key);
  if (existing) return existing;
  const refreshing = (async () => {
    const tokens = tokenSchema.parse(
      await panelJson(
        current.origin,
        "/oauth/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: current.clientId,
          refresh_token: current.refreshToken,
          resource: `${current.origin}/mcp`,
        }),
        true,
      ),
    );
    return pluginTransaction((s) => {
      const remote = requireGroup(s, groupId).servers.find(
        (r) => r.id === serverId,
      );
      if (!remote || remote.refreshToken !== current.refreshToken)
        throw new Error("The server connection changed. Retry the request.");
      remote.accessToken = tokens.access_token;
      remote.refreshToken = tokens.refresh_token;
      remote.expiresAt = Date.now() + tokens.expires_in * 1000;
      return { ...remote };
    });
  })().finally(() => refreshes.delete(key));
  refreshes.set(key, refreshing);
  return refreshing;
}

type Elicit = (params: ElicitRequestParams) => Promise<ElicitResult>;
export async function withPanelClient<T>(
  remote: PluginServer,
  work: (client: Client) => Promise<T>,
  elicit?: Elicit,
): Promise<T> {
  const client = new Client(
    { name: "Panelavo Connect", version: "1.0.0" },
    {
      capabilities: elicit ? { elicitation: { form: {} } } : {},
    },
  );
  if (elicit)
    client.setRequestHandler("elicitation/create", (request) =>
      elicit(request.params),
    );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${remote.origin}/mcp`),
    {
      authProvider: { token: async () => remote.accessToken },
      fetch: panelFetch,
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    },
  );
  try {
    await client.connect(transport, { timeout: 20_000 });
    return await work(client);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close();
  }
}

export async function disconnectServer(groupId: string, serverId: string) {
  // Erase the local credential even if the originating server is offline.
  const remote = await pluginTransaction((s) => {
    const group = requireGroup(s, groupId);
    const found = group.servers.find((r) => r.id === serverId);
    group.servers = group.servers.filter((r) => r.id !== serverId);
    return found;
  });
  if (!remote) return;
  await revokeRemote(remote);
}

export async function revokeRemote(remote: PluginServer) {
  await panelJson(
    remote.origin,
    "/oauth/revoke",
    new URLSearchParams({
      client_id: remote.clientId,
      token: remote.refreshToken,
      token_type_hint: "refresh_token",
    }),
    true,
  ).catch(() => undefined);
}
