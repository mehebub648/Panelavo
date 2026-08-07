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

export type ApiTokenScope = "sites:read" | "sites:write";
type TokenRecord = {
  id: string;
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

const store = jsonStore<Store>("api-tokens.json", () => ({ tokens: [] }));

function digest(id: string, secret: string) {
  return createHmac("sha256", appSecret())
    .update(`${id}:${secret}`)
    .digest("hex");
}

function publicRecord(record: TokenRecord): PublicApiToken {
  return {
    id: record.id,
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
  input: { name: string; scopes: ApiTokenScope[]; expiresInDays?: number },
) {
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
}

export async function revokeApiToken(username: string, id: string) {
  const value = await store.load();
  value.tokens = value.tokens.filter(
    (item) =>
      !(
        item.id === id && item.username.toLowerCase() === username.toLowerCase()
      ),
  );
  await store.save(value);
}

export async function authenticateApiToken(
  request: Request,
  required: ApiTokenScope,
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
  const user = await getCloudPanelClient().getCurrentUser(cloudPanel);
  record.lastUsedAt = new Date().toISOString();
  await store.save(value);
  return { id: record.id, user, cloudPanel, scopes: record.scopes };
}
