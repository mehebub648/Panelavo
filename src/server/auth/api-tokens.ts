import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { jsonStore } from "@/server/storage/json-store";
import { appSecret } from "@/server/auth/session";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { decorateUser } from "@/server/auth/panel-roles";

export type ApiTokenScope = "sites:read" | "sites:write" | "deployments:write";
type TokenRecord = {
  id: string;
  deployment?: { siteId: string; domain: string; ownerUserId: string };
  username: string;
  name: string;
  hash: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
};
type Store = { tokens: TokenRecord[] };
export type PublicApiToken = Omit<TokenRecord, "hash" | "username">;

const store = jsonStore<Store>(
  "api-tokens.json",
  () => ({ tokens: [] }),
  undefined,
  true,
);
let mutationQueue: Promise<unknown> = Promise.resolve();
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(work, work);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}

function digest(id: string, secret: string) {
  return createHmac("sha256", appSecret())
    .update(`${id}:${secret}`)
    .digest("hex");
}

function publicRecord(record: TokenRecord): PublicApiToken {
  return {
    id: record.id,
    ...(record.deployment ? { deployment: record.deployment } : {}),
    name: record.name,
    scopes: record.scopes,
    createdAt: record.createdAt,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}

export async function listApiTokens(
  username: string,
): Promise<PublicApiToken[]> {
  const value = await store.load();
  return value.tokens
    .filter((item) => item.username.toLowerCase() === username.toLowerCase())
    .map(publicRecord)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createApiToken(
  username: string,
  input: {
    name: string;
    scopes: ApiTokenScope[];
    expiresInDays?: number;
    deployment?: TokenRecord["deployment"];
  },
) {
  if (
    input.scopes.includes("deployments:write") &&
    (!input.deployment || input.scopes.length !== 1)
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Deployment tokens must be restricted to one website.",
      400,
    );
  if (
    input.deployment &&
    (input.scopes.length !== 1 || input.scopes[0] !== "deployments:write")
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Deployment tokens cannot access other APIs.",
      400,
    );
  if (input.deployment && !input.expiresInDays) input.expiresInDays = 90;
  return mutate(async () => {
    const value = await store.load();
    const owned = value.tokens.filter(
      (item) => item.username.toLowerCase() === username.toLowerCase(),
    );
    if (owned.length >= 50)
      throw new AppError(
        "INVALID_REQUEST",
        "Revoke an existing token before creating another.",
        409,
      );
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const record: TokenRecord = {
      id,
      deployment: input.deployment,
      username,
      name: input.name.trim().slice(0, 80),
      hash: digest(id, secret),
      scopes: [...new Set(input.scopes)],
      createdAt: new Date().toISOString(),
      ...(input.expiresInDays
        ? {
            expiresAt: new Date(
              Date.now() + input.expiresInDays * 86_400_000,
            ).toISOString(),
          }
        : {}),
    };
    value.tokens.push(record);
    await store.save(value);
    return { token: `pnl_${id}_${secret}`, record: publicRecord(record) };
  });
}

export async function revokeApiToken(username: string, id: string) {
  return mutate(async () => {
    const value = await store.load();
    value.tokens = value.tokens.filter(
      (item) =>
        !(
          item.id === id &&
          item.username.toLowerCase() === username.toLowerCase()
        ),
    );
    await store.save(value);
  });
}

export async function authenticateApiToken(
  request: Request,
  required: ApiTokenScope,
  domain?: string,
) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer pnl_([0-9a-f-]{36})_([A-Za-z0-9_-]{40,50})$/.exec(
    authorization,
  );
  if (!match)
    throw new AppError(
      "SESSION_EXPIRED",
      "A valid API token is required.",
      401,
    );
  const [, id, secret] = match;
  const value = await store.load();
  const record = value.tokens.find((item) => item.id === id);
  const expected = record ? Buffer.from(record.hash, "hex") : Buffer.alloc(32);
  const received = Buffer.from(digest(id, secret), "hex");
  if (
    !record ||
    !timingSafeEqual(expected, received) ||
    (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
  )
    throw new AppError(
      "SESSION_EXPIRED",
      "The API token is invalid or expired.",
      401,
    );
  if (!record.scopes.includes(required))
    throw new AppError(
      "FORBIDDEN",
      `This token does not have the ${required} scope.`,
      403,
    );
  const cloudPanel = {
    cookies: {},
    usernameHint: record.username,
    cliAuthenticated: true,
  } as const;
  const user = await decorateUser(
    await getCloudPanelClient().getCurrentUser(cloudPanel),
  );
  if (user.status === false)
    throw new AppError("FORBIDDEN", "This account is disabled.", 403);
  if (record.deployment) {
    if (
      required !== "deployments:write" ||
      !domain ||
      record.deployment.domain !== domain.toLowerCase() ||
      record.deployment.ownerUserId !== String(user.id)
    )
      throw new AppError(
        "FORBIDDEN",
        "This token can deploy only its configured website.",
        403,
      );
    const sites = await getCloudPanelClient().listSites(cloudPanel);
    if (
      !sites.some(
        (site) =>
          String(site.id) === record.deployment?.siteId &&
          site.domain.toLowerCase() === domain.toLowerCase(),
      )
    )
      throw new AppError(
        "FORBIDDEN",
        "The token's website is no longer accessible.",
        403,
      );
  }
  await mutate(async () => {
    const current = await store.load();
    const active = current.tokens.find(
      (item) => item.id === record.id && item.hash === record.hash,
    );
    if (
      !active ||
      (active.expiresAt && Date.parse(active.expiresAt) <= Date.now())
    )
      throw new AppError(
        "SESSION_EXPIRED",
        "The API token was revoked or expired.",
        401,
      );
    active.lastUsedAt = new Date().toISOString();
    await store.save(current);
  });
  return { id: record.id, user, cloudPanel, scopes: record.scopes };
}

export async function assertDeploymentTokenActive(
  id: string,
  ownerUserId: string,
  siteId: string,
) {
  const record = (await store.load()).tokens.find((item) => item.id === id);
  if (
    !record ||
    !record.deployment ||
    record.deployment.ownerUserId !== ownerUserId ||
    record.deployment.siteId !== siteId ||
    !record.scopes.includes("deployments:write") ||
    (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
  )
    throw new AppError(
      "FORBIDDEN",
      "The deployment token was revoked or expired.",
      403,
    );
}
