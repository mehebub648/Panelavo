import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseFleetOrigin } from "@/server/fleet/network";
import { GROUP_LIFETIME, LOGIN_LIFETIME } from "./config";
import {
  digest,
  secret,
  pluginTransaction,
  requireGroup,
  type PluginServer,
} from "./store";
import { panelJson } from "./network";
import { tokenSchema, withPanelClient } from "./remote";
import { readPanelIdentity } from "./profile";

export async function beginServerLogin(
  groupId: string,
  browserHash: string,
  input: unknown,
  gatewayOrigin: string,
) {
  const values = z
    .object({
      origin: z.string().max(2048),
      label: z.string().trim().min(1).max(80),
    })
    .parse(input);
  const origin = parseFleetOrigin(values.origin);
  const redirectUri = `${gatewayOrigin}/connect/callback`;
  await pluginTransaction((s) => {
    const group = requireGroup(s, groupId);
    if (group.browserHash !== browserHash || group.servers.length >= 20)
      throw new Error(
        "This browser cannot add another server to this connection.",
      );
  });
  const registered = z.object({ client_id: z.string().min(1).max(256) }).parse(
    await panelJson(origin, "/oauth/register", {
      client_name: "Panelavo Connect",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );
  const state = secret();
  const verifier = secret();
  await pluginTransaction((s) => {
    const group = requireGroup(s, groupId);
    if (group.browserHash !== browserHash)
      throw new Error("The browser session changed.");
    s.logins = s.logins.filter((l) => l.groupId !== groupId);
    s.logins.push({
      stateHash: digest(state),
      groupId,
      browserHash,
      origin,
      label: values.label,
      clientId: registered.client_id,
      verifier,
      redirectUri,
      expiresAt: Date.now() + LOGIN_LIFETIME,
    });
  });
  return `${origin}/oauth/authorize?${new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "panelavo:access",
    resource: `${origin}/mcp`,
    state,
    code_challenge: digest(verifier),
    code_challenge_method: "S256",
  })}`;
}

export async function finishServerLogin(
  browserHash: string,
  stateValue: string,
  code: string,
  issuer?: string,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(stateValue) || code.length > 4096 || !code)
    throw new Error("Invalid sign-in response.");
  const login = await pluginTransaction((s) => {
    const index = s.logins.findIndex(
      (l) =>
        l.stateHash === digest(stateValue) && l.browserHash === browserHash,
    );
    if (index < 0)
      throw new Error(
        "This sign-in expired or belongs to a different browser.",
      );
    const pending = s.logins[index];
    const group = requireGroup(s, pending.groupId);
    if (
      group.browserHash !== browserHash ||
      (issuer && issuer !== pending.origin)
    )
      throw new Error("The sign-in origin does not match.");
    s.logins.splice(index, 1);
    return pending;
  });
  const tokens = tokenSchema.parse(
    await panelJson(
      login.origin,
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: login.clientId,
        redirect_uri: login.redirectUri,
        code_verifier: login.verifier,
        resource: `${login.origin}/mcp`,
      }),
      true,
    ),
  );
  const remote: PluginServer = {
    id: randomUUID(),
    origin: login.origin,
    label: login.label,
    clientId: login.clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  try {
    await withPanelClient(remote, async (client) => {
      const identity = await client.callTool({
        name: "panelavo_whoami",
        arguments: {},
      });
      readPanelIdentity(identity);
    });
    await pluginTransaction((s) => {
      const group = requireGroup(s, login.groupId);
      if (group.browserHash !== browserHash || group.servers.length >= 20)
        throw new Error("This connection cannot accept another server.");
      // Never replace another login silently, including another account on the same server.
      if (!group.servers.length) group.expiresAt = Date.now() + GROUP_LIFETIME;
      group.servers.push(remote);
    });
  } catch (error) {
    await panelJson(
      remote.origin,
      "/oauth/revoke",
      new URLSearchParams({
        client_id: remote.clientId,
        token: remote.refreshToken,
      }),
      true,
    ).catch(() => undefined);
    throw error;
  }
  return login.groupId;
}
