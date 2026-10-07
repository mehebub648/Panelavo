import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod4";
import { digest, pluginTransaction, requireGroup } from "./store";
import { serverCredentials, withPanelClient } from "./remote";

const accountSchema = z.object({
  id: z.string().trim().min(1).max(256),
  username: z.string().min(1).max(256),
  displayName: z.string().max(256).optional(),
  serverIp: z.string().max(64).optional(),
  role: z.string().max(80),
  capabilities: z.object({
    readWebsites: z.boolean(),
    manageWebsites: z.boolean(),
    createWebsites: z.boolean(),
    hostWebsiteRepairs: z.boolean(),
  }),
});

export const profileSchema = z
  .object({
    id: z.string().min(1).regex(/\S/),
    name: z.string().optional(),
    nickname: z.string().optional(),
  })
  .strict();

export function readPanelIdentity(response: {
  isError?: boolean;
  structuredContent?: unknown;
}) {
  if (response.isError)
    throw new Error(
      "The server could not verify your Panelavo account. Reconnect it in the browser.",
    );
  const parsed = accountSchema.safeParse(response.structuredContent);
  if (!parsed.success)
    throw new Error(
      "Update this Panelavo server to a version supporting plugin account profiles, then reconnect it.",
    );
  return {
    ...parsed.data,
    serverIp:
      parsed.data.serverIp && isIP(parsed.data.serverIp)
        ? parsed.data.serverIp
        : null,
  };
}

type ConnectedServer = {
  id: string;
  label: string;
  origin: string;
  available: boolean;
  serverIp: string | null;
  identity?: ReturnType<typeof readPanelIdentity>;
  message?: string;
};

export async function connectedServers(
  groupId: string,
): Promise<ConnectedServer[]> {
  const remotes = await pluginTransaction((s) =>
    requireGroup(s, groupId).servers.map(({ id, label, origin }) => ({
      id,
      label,
      origin,
    })),
  );
  return Promise.all(
    remotes.map(async (remote) => {
      try {
        const credentials = await serverCredentials(groupId, remote.id);
        const identity = await withPanelClient(credentials, async (client) =>
          readPanelIdentity(
            await client.callTool({ name: "panelavo_whoami", arguments: {} }),
          ),
        );
        return {
          ...remote,
          available: true,
          serverIp: identity.serverIp,
          identity,
        };
      } catch (error) {
        return {
          ...remote,
          available: false,
          serverIp: null,
          message:
            error instanceof Error &&
            error.message.startsWith("Update this Panelavo")
              ? error.message
              : "Server unavailable or sign-in expired. Reconnect it in the browser.",
        };
      }
    }),
  );
}

export async function connectedProfile(groupId: string) {
  const servers = await connectedServers(groupId);
  if (!servers.length || servers.some((s) => !s.available || !s.identity))
    throw new Error(
      "Profile unavailable. Reconnect or update unavailable servers in Panelavo's connection page.",
    );
  // A profile is the full set of authenticated server accounts, independent of
  // connection IDs, tokens, labels, account names, or the order they were added.
  const accountsHash = digest(
    JSON.stringify(
      [
        ...new Set(
          servers.map((s) => JSON.stringify([s.origin, s.identity!.id])),
        ),
      ].sort(),
    ),
  );
  const id = await pluginTransaction((state) => {
    const group = requireGroup(state, groupId);
    if (
      group.servers.length !== servers.length ||
      group.servers.some((s) => !servers.some((r) => r.id === s.id))
    )
      throw new Error("Connected servers changed. Retry the request.");
    const profiles = (state.profiles ??= []);
    const existing = profiles.find((p) => p.accountsHash === accountsHash);
    if (existing) return existing.id;
    const assigned = { accountsHash, id: `prf_${randomUUID()}` };
    profiles.push(assigned);
    return assigned.id;
  });
  const nickname = servers
    .map(
      (s) =>
        `${s.serverIp ?? new URL(s.origin).hostname} · ${s.identity!.displayName || s.identity!.username}`,
    )
    .join("; ");
  return { id, name: nickname, nickname };
}
