import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import type { ValidatedMcpAuthorizationRequest } from "@/server/mcp/oauth";
import { AppError } from "@/server/cloudpanel/errors";
import { LOGIN_LIFETIME } from "./config";

export type PluginServer = {
  id: string;
  origin: string;
  label: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};
export type PluginGroup = {
  id: string;
  browserHash: string;
  csrf: string;
  clientId: string;
  expiresAt: number;
  servers: PluginServer[];
  authorization?: ValidatedMcpAuthorizationRequest;
};
export type PluginLogin = {
  stateHash: string;
  groupId: string;
  browserHash: string;
  origin: string;
  label: string;
  clientId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
};
export type PluginStore = {
  groups: PluginGroup[];
  logins: PluginLogin[];
  // Opaque identities outlive expiring OAuth groups and contain no credentials.
  profiles?: Array<{ accountsHash: string; id: string }>;
};
const store = encryptedJsonStore<PluginStore>(
  "plugin-connections.enc.json",
  () => ({ groups: [], logins: [] }),
);
let queue: Promise<unknown> = Promise.resolve();

export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

export function pluginTransaction<T>(
  work: (state: PluginStore) => T | Promise<T>,
): Promise<T> {
  const operation = queue.then(async () => {
    const state = await store.load();
    const now = Date.now();
    state.groups = state.groups.filter((g) => g.expiresAt > now);
    state.logins = state.logins.filter(
      (l) => l.expiresAt > now && state.groups.some((g) => g.id === l.groupId),
    );
    const result = await work(state);
    await store.save(state);
    return result;
  });
  queue = operation.catch(() => undefined);
  return operation;
}

export function requireGroup(state: PluginStore, id: string) {
  const group = state.groups.find(
    (g) => g.id === id && g.expiresAt > Date.now(),
  );
  if (!group)
    throw new AppError(
      "SESSION_EXPIRED",
      "Reconnect the Panelavo plugin. This connection has expired.",
      401,
    );
  return group;
}

export async function browserGroup(cookie: string | undefined) {
  if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined;
  return pluginTransaction((s) =>
    s.groups.find((g) => g.browserHash === digest(cookie)),
  );
}

export async function createGroup(
  authorization: ValidatedMcpAuthorizationRequest,
) {
  const cookie = secret();
  const group = await pluginTransaction((state) => {
    if (state.groups.length >= 1000)
      throw new AppError(
        "INVALID_REQUEST",
        "The plugin service is at capacity. Try again later.",
        429,
      );
    const value: PluginGroup = {
      id: randomUUID(),
      browserHash: digest(cookie),
      csrf: secret(),
      clientId: authorization.clientId,
      expiresAt: Date.now() + LOGIN_LIFETIME,
      servers: [],
      authorization,
    };
    state.groups.push(value);
    return value;
  });
  return { group, cookie };
}

// This identifies an OAuth connection group, never a local CloudPanel account.
export function groupSubject(group: PluginGroup) {
  return {
    id: `plugin:${group.id}`,
    username: "Connected Panelavo servers",
    canCreateSites: false,
  };
}
