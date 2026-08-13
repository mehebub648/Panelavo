import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { appSecret } from "@/server/auth/session";
import type { PanelActor } from "@/server/auth/site-access";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { audit } from "@/server/security/log";
import { jsonStore } from "@/server/storage/json-store";
import type { CloudPanelSession, CloudPanelUser } from "@/types/cloudpanel";
import { getMcpPublicUrls, type McpPublicUrls } from "./public-url";

export const MCP_SCOPE = "panelavo:access";

const AUTHORIZATION_CODE_LIFETIME_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CONSENT_LIFETIME_MS = 5 * 60 * 1000;
const UNUSED_CLIENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENTS = 500;
const MAX_CONNECTIONS_PER_USER = 50;
const MAX_PENDING_CONSENTS_PER_USER = 20;
const REFRESH_BURST_WINDOW_MS = 5 * 60 * 1000;
const MAX_REFRESHES_PER_BURST = 12;
const REFRESH_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REFRESHES_PER_DAY = 200;
const MAX_REFRESH_TOMBSTONES = MAX_REFRESHES_PER_DAY * 31;
const MAX_FORM_BYTES = 16 * 1024;

type ClientRecord = {
  id: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt?: number;
};

type AuthorizationRequestRecord = {
  id: string;
  hash: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  state?: string;
  username: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
};

type GrantRecord = {
  id: string;
  clientId: string;
  clientName: string;
  username: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  refreshBurstStartedAt?: number;
  refreshBurstCount?: number;
  refreshDayStartedAt?: number;
  refreshDayCount?: number;
};

type AuthorizationCodeRecord = {
  id: string;
  hash: string;
  grantId: string;
  clientId: string;
  username: string;
  userId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
};

type AccessTokenRecord = {
  id: string;
  hash: string;
  grantId: string;
  familyId: string;
  clientId: string;
  username: string;
  userId: string;
  resource: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

type RefreshTokenRecord = {
  id: string;
  hash: string;
  grantId: string;
  familyId: string;
  clientId: string;
  username: string;
  userId: string;
  resource: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
};

type RefreshFamilyRecord = {
  id: string;
  grantId: string;
  clientId: string;
  resource: string;
  usedTokenHashes: string[];
  createdAt: number;
  expiresAt: number;
};

type McpOAuthStore = {
  clients: ClientRecord[];
  authorizationRequests: AuthorizationRequestRecord[];
  grants: GrantRecord[];
  authorizationCodes: AuthorizationCodeRecord[];
  accessTokens: AccessTokenRecord[];
  refreshTokens: RefreshTokenRecord[];
  refreshFamilies: RefreshFamilyRecord[];
};

export type PublicMcpConnection = {
  id: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
};

export type RegisteredMcpClient = {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
};

export type ValidatedMcpAuthorizationRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  state?: string;
};

export type McpConsent = {
  token: string;
  clientName: string;
  redirectHost: string;
  username: string;
  scope: string;
};

export type McpTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

function emptyStore(): McpOAuthStore {
  return {
    clients: [],
    authorizationRequests: [],
    grants: [],
    authorizationCodes: [],
    accessTokens: [],
    refreshTokens: [],
    refreshFamilies: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedRefreshCount(value: unknown, maximum: number) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return maximum;
  return Math.min(value as number, maximum);
}

function normalizedGrant(value: Record<string, unknown>) {
  const grant = { ...value } as GrantRecord;
  grant.refreshBurstCount = normalizedRefreshCount(
    value.refreshBurstCount,
    MAX_REFRESHES_PER_BURST,
  );
  grant.refreshDayCount = normalizedRefreshCount(
    value.refreshDayCount,
    MAX_REFRESHES_PER_DAY,
  );
  return grant;
}

function normalizedRefreshFamily(
  value: Record<string, unknown>,
): RefreshFamilyRecord | undefined {
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.grantId !== "string" ||
    !value.grantId ||
    typeof value.clientId !== "string" ||
    !value.clientId ||
    typeof value.resource !== "string" ||
    !value.resource ||
    !finiteNumber(value.createdAt) ||
    !finiteNumber(value.expiresAt)
  )
    return undefined;
  const usedTokenHashes = Array.isArray(value.usedTokenHashes)
    ? value.usedTokenHashes
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && /^[A-Za-z0-9_-]{43}$/.test(entry),
        )
        .slice(-MAX_REFRESH_TOMBSTONES)
    : [];
  return {
    id: value.id,
    grantId: value.grantId,
    clientId: value.clientId,
    resource: value.resource,
    usedTokenHashes,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function normalizedRefreshToken(
  value: Record<string, unknown>,
): RefreshTokenRecord | undefined {
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.hash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.hash) ||
    typeof value.grantId !== "string" ||
    !value.grantId ||
    typeof value.familyId !== "string" ||
    !UUID_PATTERN.test(value.familyId) ||
    typeof value.clientId !== "string" ||
    !value.clientId ||
    typeof value.username !== "string" ||
    !value.username ||
    typeof value.userId !== "string" ||
    !value.userId ||
    typeof value.resource !== "string" ||
    !value.resource ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string") ||
    !finiteNumber(value.createdAt) ||
    !finiteNumber(value.expiresAt)
  )
    return undefined;
  return {
    id: value.id,
    hash: value.hash,
    grantId: value.grantId,
    familyId: value.familyId,
    clientId: value.clientId,
    username: value.username,
    userId: value.userId,
    resource: value.resource,
    scopes: [...value.scopes],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function normalizeStore(value: unknown): McpOAuthStore {
  if (!isRecord(value)) return emptyStore();
  const records = (key: keyof McpOAuthStore) =>
    Array.isArray(value[key]) ? value[key].filter(isRecord) : [];
  const refreshFamilies = records("refreshFamilies")
    .map(normalizedRefreshFamily)
    .filter((family): family is RefreshFamilyRecord => Boolean(family));
  const familyIds = new Set(refreshFamilies.map((family) => family.id));
  const currentRefreshByFamily = new Map<string, RefreshTokenRecord>();
  for (const raw of records("refreshTokens")) {
    const token = normalizedRefreshToken(raw);
    if (!token || !familyIds.has(token.familyId)) continue;
    const current = currentRefreshByFamily.get(token.familyId);
    if (!current || token.createdAt > current.createdAt)
      currentRefreshByFamily.set(token.familyId, token);
  }
  return {
    clients: records("clients") as ClientRecord[],
    authorizationRequests: records(
      "authorizationRequests",
    ) as AuthorizationRequestRecord[],
    grants: records("grants").map(normalizedGrant),
    authorizationCodes: records(
      "authorizationCodes",
    ) as AuthorizationCodeRecord[],
    accessTokens: records("accessTokens") as AccessTokenRecord[],
    refreshTokens: [...currentRefreshByFamily.values()],
    refreshFamilies,
  };
}

const oauthStore = jsonStore<McpOAuthStore>(
  "mcp-oauth.json",
  emptyStore,
  normalizeStore,
);

const globalMcpOAuth = globalThis as typeof globalThis & {
  __panelMcpOAuthMutation?: Promise<void>;
};
globalMcpOAuth.__panelMcpOAuthMutation ??= Promise.resolve();

function sweep(state: McpOAuthStore, now = Date.now()) {
  const activeGrantIds = new Set(
    state.grants
      .filter(
        (grant) =>
          typeof grant.id === "string" &&
          finiteNumber(grant.expiresAt) &&
          grant.expiresAt > now,
      )
      .map((grant) => grant.id),
  );
  state.authorizationRequests = state.authorizationRequests.filter(
    (request) => finiteNumber(request.expiresAt) && request.expiresAt > now,
  );
  state.authorizationCodes = state.authorizationCodes.filter(
    (code) =>
      finiteNumber(code.expiresAt) &&
      code.expiresAt > now &&
      activeGrantIds.has(code.grantId),
  );
  state.accessTokens = state.accessTokens.filter(
    (token) =>
      finiteNumber(token.expiresAt) &&
      token.expiresAt > now &&
      activeGrantIds.has(token.grantId),
  );
  state.refreshFamilies = state.refreshFamilies.filter(
    (family) =>
      finiteNumber(family.expiresAt) &&
      family.expiresAt > now &&
      activeGrantIds.has(family.grantId),
  );
  const activeFamilyIds = new Set(
    state.refreshFamilies.map((family) => family.id),
  );
  // Exactly one current refresh token is retained per live family. Used values
  // are represented only by bounded, exact HMAC tombstones on that family.
  state.refreshTokens = state.refreshTokens.filter(
    (token) =>
      finiteNumber(token.expiresAt) &&
      token.expiresAt > now &&
      activeGrantIds.has(token.grantId) &&
      activeFamilyIds.has(token.familyId),
  );
  state.grants = state.grants.filter(
    (grant) => finiteNumber(grant.expiresAt) && grant.expiresAt > now,
  );

  const referencedClients = new Set(
    state.grants.map((grant) => grant.clientId),
  );
  state.clients = state.clients.filter(
    (client) =>
      referencedClients.has(client.id) ||
      (finiteNumber(client.createdAt) &&
        client.createdAt + UNUSED_CLIENT_LIFETIME_MS > now),
  );
}

async function mutateStore<T>(
  operation: (state: McpOAuthStore) => T | Promise<T>,
) {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const queued = globalMcpOAuth.__panelMcpOAuthMutation!.then(async () => {
    try {
      const state = await oauthStore.load();
      sweep(state);
      const value = await operation(state);
      await oauthStore.save(state);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  });
  globalMcpOAuth.__panelMcpOAuthMutation = queued.catch(() => undefined);
  return result;
}

async function readStore<T>(operation: (state: McpOAuthStore) => T) {
  await globalMcpOAuth.__panelMcpOAuthMutation;
  const state = await oauthStore.load();
  sweep(state);
  return operation(state);
}

function hmac(namespace: string, value: string) {
  return createHmac("sha256", appSecret())
    .update(`${namespace}\0${value}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

type OpaqueTokenKind = "consent" | "code" | "access" | "refresh";

const tokenPrefixes: Record<OpaqueTokenKind, string> = {
  consent: "pnl_mc",
  code: "pnl_mcode",
  access: "pnl_mat",
  refresh: "pnl_mrt",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createOpaqueToken(kind: OpaqueTokenKind, familyId?: string) {
  const id = randomUUID();
  if (kind === "refresh" && !UUID_PATTERN.test(familyId ?? ""))
    throw new Error("A refresh token family is required.");
  const value = [
    tokenPrefixes[kind],
    ...(kind === "refresh" ? [familyId!] : []),
    id,
    randomBytes(32).toString("base64url"),
  ].join(".");
  return { id, value, hash: hmac(kind, value) };
}

function opaqueTokenParts(kind: OpaqueTokenKind, value: string) {
  if (value.length > 240) return null;
  const parts = value.split(".");
  const [prefix, familyId, id, secret] =
    kind === "refresh" ? parts : [parts[0], undefined, parts[1], parts[2]];
  if (
    parts.length !== (kind === "refresh" ? 4 : 3) ||
    prefix !== tokenPrefixes[kind] ||
    (kind === "refresh" && !UUID_PATTERN.test(familyId ?? "")) ||
    !UUID_PATTERN.test(id ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")
  )
    return null;
  return { id: id!, familyId };
}

function opaqueTokenId(kind: OpaqueTokenKind, value: string) {
  return opaqueTokenParts(kind, value)?.id ?? null;
}

function matchingToken<T extends { id: string; hash: string }>(
  records: T[],
  kind: OpaqueTokenKind,
  value: string,
) {
  const id = opaqueTokenId(kind, value);
  if (!id) return undefined;
  const record = records.find((candidate) => candidate.id === id);
  return record &&
    typeof record.hash === "string" &&
    safeEqual(record.hash, hmac(kind, value))
    ? record
    : undefined;
}

function refreshReplayHash(value: string) {
  return createHmac("sha256", appSecret())
    .update(`refresh-replay\0${value}`)
    .digest("base64url");
}

function addRefreshReplayTombstone(family: RefreshFamilyRecord, value: string) {
  family.usedTokenHashes.push(refreshReplayHash(value));
  if (family.usedTokenHashes.length > MAX_REFRESH_TOMBSTONES)
    family.usedTokenHashes.splice(
      0,
      family.usedTokenHashes.length - MAX_REFRESH_TOMBSTONES,
    );
}

function replayedRefreshFamily(
  state: McpOAuthStore,
  value: string,
  clientId: string,
  resource: string,
) {
  const token = opaqueTokenParts("refresh", value);
  if (!token?.familyId) return undefined;
  const family = state.refreshFamilies.find(
    (candidate) =>
      candidate.id === token.familyId &&
      candidate.clientId === clientId &&
      candidate.resource === resource &&
      Array.isArray(candidate.usedTokenHashes),
  );
  if (!family) return undefined;
  const actual = refreshReplayHash(value);
  return family.usedTokenHashes.some(
    (stored) => typeof stored === "string" && safeEqual(stored, actual),
  )
    ? family
    : undefined;
}

export class McpOAuthError extends Error {
  constructor(
    public code: OAuthErrorCode | string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export class McpAuthorizationError extends McpOAuthError {
  constructor(
    code: OAuthErrorCode | string,
    message: string,
    public redirectUri?: string,
    public state?: string,
  ) {
    super(code, message);
    this.name = "McpAuthorizationError";
  }
}

function oauthError(
  code: OAuthErrorCode | string,
  message: string,
  status = 400,
): never {
  throw new McpOAuthError(code, message, status);
}

export function mcpOAuthErrorResponse(error: unknown) {
  const known =
    error instanceof McpOAuthError
      ? error
      : new McpOAuthError(
          OAuthErrorCode.ServerError,
          "Panelavo could not complete the authorization request.",
          500,
        );
  return Response.json(
    { error: known.code, error_description: known.message },
    {
      status: known.status,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

export async function parseMcpOAuthForm(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded"))
    oauthError(
      OAuthErrorCode.InvalidRequest,
      "This endpoint accepts form-encoded OAuth requests.",
      415,
    );
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES)
    oauthError(
      OAuthErrorCode.InvalidRequest,
      "The OAuth request is too large.",
      413,
    );
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_FORM_BYTES)
    oauthError(
      OAuthErrorCode.InvalidRequest,
      "The OAuth request is too large.",
      413,
    );
  return new URLSearchParams(body);
}

function exactlyOne(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length !== 1)
    oauthError(
      OAuthErrorCode.InvalidRequest,
      `The ${name} parameter must be provided exactly once.`,
    );
  return values[0] ?? "";
}

function optionalOne(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1)
    oauthError(
      OAuthErrorCode.InvalidRequest,
      `The ${name} parameter may be provided only once.`,
    );
  return values[0];
}

function validLoopback(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") return true;
  if (isIP(normalized) === 4) return Number(normalized.split(".")[0]) === 127;
  return normalized === "::1";
}

function validRedirectUri(value: string) {
  if (value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return Boolean(url.hostname);
  return url.protocol === "http:" && validLoopback(url.hostname);
}

function normalizedClientName(value: unknown) {
  if (value === undefined) return "AI assistant";
  if (typeof value !== "string")
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "client_name must be text.",
    );
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name || name.length > 100)
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "client_name must contain between 1 and 100 characters.",
    );
  return name;
}

function stringArrayMetadata(
  input: Record<string, unknown>,
  key: string,
  fallback: string[],
) {
  const value = input[key];
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((item) => typeof item === "string")
  )
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      `${key} must be a non-empty list of text values.`,
    );
  return value as string[];
}

export async function registerMcpOAuthClient(
  value: unknown,
): Promise<RegisteredMcpClient> {
  if (!isRecord(value))
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "Client registration must be a JSON object.",
    );
  const redirectUris = stringArrayMetadata(value, "redirect_uris", []);
  if (
    !redirectUris.length ||
    redirectUris.length > 10 ||
    new Set(redirectUris).size !== redirectUris.length ||
    !redirectUris.every(validRedirectUri)
  )
    oauthError(
      OAuthErrorCode.InvalidRedirectUri,
      "Use one to ten unique HTTPS redirects, or HTTP redirects on a loopback address.",
    );

  const authenticationMethod = value.token_endpoint_auth_method ?? "none";
  if (authenticationMethod !== "none")
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "Panelavo registers public OAuth clients without a client secret.",
    );
  const responseTypes = stringArrayMetadata(value, "response_types", ["code"]);
  if (responseTypes.length !== 1 || responseTypes[0] !== "code")
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "Only the authorization code response type is supported.",
    );
  const grantTypes = stringArrayMetadata(value, "grant_types", [
    "authorization_code",
    "refresh_token",
  ]);
  if (
    grantTypes.length !== 2 ||
    !grantTypes.includes("authorization_code") ||
    !grantTypes.includes("refresh_token") ||
    grantTypes.some(
      (grant) => !["authorization_code", "refresh_token"].includes(grant),
    ) ||
    new Set(grantTypes).size !== grantTypes.length
  )
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "Only authorization_code and refresh_token grants are supported.",
    );
  if (
    value.application_type !== undefined &&
    !["native", "web"].includes(String(value.application_type))
  )
    oauthError(
      OAuthErrorCode.InvalidClientMetadata,
      "application_type must be native or web.",
    );
  if (value.scope !== undefined && value.scope !== MCP_SCOPE)
    oauthError(
      OAuthErrorCode.InvalidScope,
      `The supported scope is ${MCP_SCOPE}.`,
    );

  const clientName = normalizedClientName(value.client_name);
  const now = Date.now();
  const client = await mutateStore((state) => {
    if (state.clients.length >= MAX_CLIENTS) {
      const referenced = new Set([
        ...state.grants.map((grant) => grant.clientId),
        ...state.authorizationRequests.map((request) => request.clientId),
      ]);
      const evictable = state.clients
        .filter((candidate) => !referenced.has(candidate.id))
        .sort((left, right) => left.createdAt - right.createdAt);
      while (state.clients.length >= MAX_CLIENTS && evictable.length) {
        const oldest = evictable.shift();
        if (!oldest) break;
        state.clients = state.clients.filter(
          (candidate) => candidate.id !== oldest.id,
        );
      }
    }
    if (state.clients.length >= MAX_CLIENTS)
      oauthError(
        OAuthErrorCode.TemporarilyUnavailable,
        "Panelavo cannot register another client right now.",
        503,
      );
    const record: ClientRecord = {
      id: `pnl_client_${randomUUID()}`,
      clientName,
      redirectUris,
      createdAt: now,
    };
    state.clients.push(record);
    return record;
  });
  await audit("mcp.oauth.client_registered", "success", {
    target: { type: "oauth-client", id: client.id },
  });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt / 1000),
    client_name: client.clientName,
    redirect_uris: [...client.redirectUris],
    grant_types: [...grantTypes],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: MCP_SCOPE,
  };
}

function authorizationFailure(
  code: OAuthErrorCode | string,
  message: string,
  redirectUri?: string,
  state?: string,
): never {
  throw new McpAuthorizationError(code, message, redirectUri, state);
}

export async function validateMcpAuthorizationRequest(
  params: URLSearchParams,
  urls: McpPublicUrls,
): Promise<ValidatedMcpAuthorizationRequest> {
  let clientId: string;
  let redirectUri: string;
  try {
    clientId = exactlyOne(params, "client_id");
    redirectUri = exactlyOne(params, "redirect_uri");
  } catch (error) {
    if (error instanceof McpOAuthError)
      authorizationFailure(error.code, error.message);
    throw error;
  }
  const client = await readStore((state) =>
    state.clients.find((candidate) => candidate.id === clientId),
  );
  if (!client || !client.redirectUris.includes(redirectUri))
    authorizationFailure(
      OAuthErrorCode.InvalidRequest,
      "The OAuth client or redirect address is not registered.",
    );

  let state: string | undefined;
  try {
    state = optionalOne(params, "state");
  } catch (error) {
    if (error instanceof McpOAuthError)
      authorizationFailure(error.code, error.message, redirectUri);
    throw error;
  }
  if (state !== undefined && state.length > 1024)
    authorizationFailure(
      OAuthErrorCode.InvalidRequest,
      "The state parameter is too long.",
      redirectUri,
    );

  const fail = (code: OAuthErrorCode | string, message: string): never =>
    authorizationFailure(code, message, redirectUri, state);
  let responseType: string;
  let scope: string;
  let resource: string;
  let codeChallenge: string;
  let challengeMethod: string;
  try {
    responseType = exactlyOne(params, "response_type");
    scope = exactlyOne(params, "scope");
    resource = exactlyOne(params, "resource");
    codeChallenge = exactlyOne(params, "code_challenge");
    challengeMethod = exactlyOne(params, "code_challenge_method");
  } catch (error) {
    if (error instanceof McpOAuthError) fail(error.code, error.message);
    throw error;
  }
  if (responseType !== "code")
    fail(
      OAuthErrorCode.UnsupportedResponseType,
      "Only the authorization code response type is supported.",
    );
  if (scope !== MCP_SCOPE)
    fail(OAuthErrorCode.InvalidScope, `The supported scope is ${MCP_SCOPE}.`);
  if (resource !== urls.resource)
    fail(
      OAuthErrorCode.InvalidTarget,
      "The requested resource does not match this Panelavo MCP server.",
    );
  if (challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
    fail(
      OAuthErrorCode.InvalidRequest,
      "A valid S256 PKCE challenge is required.",
    );

  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    resource,
    scope,
    codeChallenge,
    state,
  };
}

function stableIdentity(user: CloudPanelUser) {
  const userId = String(user.id ?? "").trim();
  const username = String(user.username ?? "").trim();
  if (!userId || userId.length > 200 || !username || username.length > 200)
    oauthError(
      OAuthErrorCode.ServerError,
      "Panelavo could not bind this connection to the current account.",
      500,
    );
  return { userId, username };
}

export async function createMcpConsent(
  request: ValidatedMcpAuthorizationRequest,
  user: CloudPanelUser,
): Promise<McpConsent> {
  const identity = stableIdentity(user);
  const token = createOpaqueToken("consent");
  const now = Date.now();
  await mutateStore((state) => {
    // A browser refresh replaces the same pending approval instead of adding
    // another durable record for the same account and client.
    state.authorizationRequests = state.authorizationRequests.filter(
      (candidate) =>
        candidate.userId !== identity.userId ||
        candidate.clientId !== request.clientId,
    );
    const pending = state.authorizationRequests
      .filter((candidate) => candidate.userId === identity.userId)
      .sort((left, right) => left.createdAt - right.createdAt);
    while (pending.length >= MAX_PENDING_CONSENTS_PER_USER) {
      const oldest = pending.shift();
      if (!oldest) break;
      state.authorizationRequests = state.authorizationRequests.filter(
        (candidate) => candidate.id !== oldest.id,
      );
    }
    state.authorizationRequests.push({
      id: token.id,
      hash: token.hash,
      ...request,
      ...identity,
      createdAt: now,
      expiresAt: now + CONSENT_LIFETIME_MS,
    });
  });
  return {
    token: token.value,
    clientName: request.clientName,
    redirectHost: new URL(request.redirectUri).host,
    username: identity.username,
    scope: request.scope,
  };
}

export async function prepareMcpConsent(
  params: URLSearchParams,
  urls: McpPublicUrls,
  user: CloudPanelUser,
) {
  return createMcpConsent(
    await validateMcpAuthorizationRequest(params, urls),
    user,
  );
}

function redirectWithOAuthResult(
  redirectUri: string,
  values: Record<string, string | undefined>,
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function mcpAuthorizationErrorRedirect(error: unknown) {
  if (!(error instanceof McpAuthorizationError) || !error.redirectUri)
    return undefined;
  return redirectWithOAuthResult(error.redirectUri, {
    error: String(error.code),
    error_description: error.message,
    state: error.state,
  });
}

function revokeGrantTokens(state: McpOAuthStore, grantId: string, now: number) {
  for (const token of state.accessTokens) {
    if (token.grantId === grantId && !token.revokedAt) token.revokedAt = now;
  }
  state.refreshTokens = state.refreshTokens.filter(
    (token) => token.grantId !== grantId,
  );
  state.refreshFamilies = state.refreshFamilies.filter(
    (family) => family.grantId !== grantId,
  );
}

export async function completeMcpAuthorization(
  consentToken: string,
  decision: "approve" | "deny",
  user: CloudPanelUser,
) {
  const identity = stableIdentity(user);
  const now = Date.now();
  const result = await mutateStore((state) => {
    const request = matchingToken(
      state.authorizationRequests,
      "consent",
      consentToken,
    );
    if (!request || request.expiresAt <= now)
      oauthError(
        OAuthErrorCode.InvalidRequest,
        "This approval request expired. Start the connection again.",
      );
    if (request.userId !== identity.userId)
      oauthError(
        OAuthErrorCode.AccessDenied,
        "This approval belongs to a different Panelavo account.",
        403,
      );
    const client = state.clients.find(
      (candidate) => candidate.id === request.clientId,
    );
    if (!client || !client.redirectUris.includes(request.redirectUri))
      oauthError(
        OAuthErrorCode.InvalidRequest,
        "The registered OAuth client is no longer available.",
      );

    state.authorizationRequests = state.authorizationRequests.filter(
      (candidate) => candidate.id !== request.id,
    );
    client.lastUsedAt = now;
    if (decision === "deny") {
      return {
        redirect: redirectWithOAuthResult(request.redirectUri, {
          error: OAuthErrorCode.AccessDenied,
          error_description:
            "The Panelavo user did not approve this connection.",
          state: request.state,
        }),
        clientId: request.clientId,
        decision: "deny" as const,
      };
    }

    let grant = state.grants.find(
      (candidate) =>
        candidate.clientId === request.clientId &&
        candidate.userId === identity.userId &&
        !candidate.revokedAt &&
        candidate.expiresAt > now,
    );
    if (!grant) {
      const connectionCount = state.grants.filter(
        (candidate) =>
          candidate.userId === identity.userId &&
          !candidate.revokedAt &&
          candidate.expiresAt > now,
      ).length;
      if (connectionCount >= MAX_CONNECTIONS_PER_USER)
        oauthError(
          OAuthErrorCode.AccessDenied,
          "Disconnect an older AI connection before adding another one.",
          403,
        );
      grant = {
        id: randomUUID(),
        clientId: request.clientId,
        clientName: request.clientName,
        ...identity,
        createdAt: now,
        expiresAt: now + GRANT_LIFETIME_MS,
      };
      state.grants.push(grant);
    } else {
      grant.username = identity.username;
      grant.clientName = request.clientName;
      grant.expiresAt = now + GRANT_LIFETIME_MS;
    }
    const code = createOpaqueToken("code");
    state.authorizationCodes.push({
      id: code.id,
      hash: code.hash,
      grantId: grant.id,
      clientId: request.clientId,
      username: identity.username,
      userId: identity.userId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      codeChallenge: request.codeChallenge,
      createdAt: now,
      expiresAt: now + AUTHORIZATION_CODE_LIFETIME_MS,
    });
    return {
      redirect: redirectWithOAuthResult(request.redirectUri, {
        code: code.value,
        state: request.state,
      }),
      clientId: request.clientId,
      grantId: grant.id,
      decision: "approve" as const,
    };
  });
  await audit("mcp.oauth.grant", "success", {
    actor: identity.userId,
    target: {
      type: result.decision === "approve" ? "mcp-connection" : "oauth-client",
      id: result.grantId ?? result.clientId,
    },
    details: { decision: result.decision, clientId: result.clientId },
  });
  return result.redirect;
}

function validPkceVerifier(value: string) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function pkceMatches(verifier: string, challenge: string) {
  if (!validPkceVerifier(verifier)) return false;
  const actual = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return safeEqual(actual, challenge);
}

function issueTokenPair(
  state: McpOAuthStore,
  grant: GrantRecord,
  familyId: string,
  resource: string,
  scopes: string[],
  now: number,
) {
  const access = createOpaqueToken("access");
  const refresh = createOpaqueToken("refresh", familyId);
  const accessExpiresAt = Math.min(
    now + ACCESS_TOKEN_LIFETIME_MS,
    grant.expiresAt,
  );
  const common = {
    grantId: grant.id,
    familyId,
    clientId: grant.clientId,
    username: grant.username,
    userId: grant.userId,
    resource,
    scopes,
    createdAt: now,
  };
  let family = state.refreshFamilies.find(
    (candidate) => candidate.id === familyId,
  );
  if (!family) {
    family = {
      id: familyId,
      grantId: grant.id,
      clientId: grant.clientId,
      resource,
      usedTokenHashes: [],
      createdAt: now,
      expiresAt: grant.expiresAt,
    };
    state.refreshFamilies.push(family);
  } else {
    family.expiresAt = grant.expiresAt;
  }
  state.accessTokens.push({
    id: access.id,
    hash: access.hash,
    ...common,
    expiresAt: accessExpiresAt,
  });
  state.refreshTokens = state.refreshTokens.filter(
    (candidate) => candidate.familyId !== familyId,
  );
  state.refreshTokens.push({
    id: refresh.id,
    hash: refresh.hash,
    ...common,
    expiresAt: grant.expiresAt,
  });
  grant.lastUsedAt = now;
  return {
    accessToken: access.value,
    refreshToken: refresh.value,
    expiresIn: Math.max(1, Math.floor((accessExpiresAt - now) / 1000)),
  };
}

function tokenResponse(
  tokens: ReturnType<typeof issueTokenPair>,
): McpTokenResponse {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: MCP_SCOPE,
  };
}

function assertTokenClient(params: URLSearchParams) {
  const clientId = exactlyOne(params, "client_id");
  const secret = optionalOne(params, "client_secret");
  if (secret !== undefined)
    oauthError(
      OAuthErrorCode.InvalidClient,
      "This public OAuth client must not send a client secret.",
      401,
    );
  return clientId;
}

async function exchangeAuthorizationCode(
  params: URLSearchParams,
  urls: McpPublicUrls,
) {
  const clientId = assertTokenClient(params);
  const codeValue = exactlyOne(params, "code");
  const redirectUri = exactlyOne(params, "redirect_uri");
  const verifier = exactlyOne(params, "code_verifier");
  const resource = exactlyOne(params, "resource");
  const requestedScope = optionalOne(params, "scope");
  if (resource !== urls.resource)
    oauthError(
      OAuthErrorCode.InvalidTarget,
      "The resource must match this Panelavo MCP server.",
    );
  if (requestedScope !== undefined && requestedScope !== MCP_SCOPE)
    oauthError(
      OAuthErrorCode.InvalidScope,
      `The supported scope is ${MCP_SCOPE}.`,
    );
  const now = Date.now();
  return mutateStore((state) => {
    const client = state.clients.find((candidate) => candidate.id === clientId);
    if (!client)
      oauthError(
        OAuthErrorCode.InvalidClient,
        "The OAuth client is unknown.",
        401,
      );
    const code = matchingToken(state.authorizationCodes, "code", codeValue);
    if (
      !code ||
      code.usedAt ||
      code.expiresAt <= now ||
      code.clientId !== clientId ||
      code.redirectUri !== redirectUri ||
      code.resource !== resource ||
      !pkceMatches(verifier, code.codeChallenge)
    )
      oauthError(
        OAuthErrorCode.InvalidGrant,
        "The authorization code is invalid, expired, or does not match this request.",
      );
    const grant = state.grants.find(
      (candidate) =>
        candidate.id === code.grantId &&
        !candidate.revokedAt &&
        candidate.expiresAt > now,
    );
    if (!grant)
      oauthError(
        OAuthErrorCode.InvalidGrant,
        "The connection is no longer active.",
      );

    code.usedAt = now;
    client.lastUsedAt = now;
    // A fresh authorization for the same connection replaces older bearer
    // material, preventing one UI connection from hiding multiple live grants.
    revokeGrantTokens(state, grant.id, now);
    return tokenResponse(
      issueTokenPair(state, grant, randomUUID(), resource, [MCP_SCOPE], now),
    );
  });
}

function revokeTokenFamily(
  state: McpOAuthStore,
  familyId: string,
  now: number,
) {
  for (const access of state.accessTokens) {
    if (access.familyId === familyId && !access.revokedAt)
      access.revokedAt = now;
  }
  state.refreshTokens = state.refreshTokens.filter(
    (refresh) => refresh.familyId !== familyId,
  );
  state.refreshFamilies = state.refreshFamilies.filter(
    (family) => family.id !== familyId,
  );
}

function consumeRefreshQuota(grant: GrantRecord, now: number) {
  if (
    !finiteNumber(grant.refreshBurstStartedAt) ||
    grant.refreshBurstStartedAt + REFRESH_BURST_WINDOW_MS <= now
  ) {
    grant.refreshBurstStartedAt = now;
    grant.refreshBurstCount = 0;
  }
  if (
    !finiteNumber(grant.refreshDayStartedAt) ||
    grant.refreshDayStartedAt + REFRESH_DAILY_WINDOW_MS <= now
  ) {
    grant.refreshDayStartedAt = now;
    grant.refreshDayCount = 0;
  }
  if ((grant.refreshBurstCount ?? 0) >= MAX_REFRESHES_PER_BURST)
    oauthError(
      OAuthErrorCode.TooManyRequests,
      "This connection refreshed too quickly. Wait a few minutes and try again.",
      429,
    );
  if ((grant.refreshDayCount ?? 0) >= MAX_REFRESHES_PER_DAY)
    oauthError(
      OAuthErrorCode.TooManyRequests,
      "This connection reached its daily refresh limit. Try again later.",
      429,
    );
  grant.refreshBurstCount = (grant.refreshBurstCount ?? 0) + 1;
  grant.refreshDayCount = (grant.refreshDayCount ?? 0) + 1;
}

async function exchangeRefreshToken(
  params: URLSearchParams,
  urls: McpPublicUrls,
) {
  const clientId = assertTokenClient(params);
  const tokenValue = exactlyOne(params, "refresh_token");
  const resource = exactlyOne(params, "resource");
  if (resource !== urls.resource)
    oauthError(
      OAuthErrorCode.InvalidTarget,
      "The resource must match this Panelavo MCP server.",
    );
  const requestedScope = optionalOne(params, "scope");
  if (requestedScope !== undefined && requestedScope !== MCP_SCOPE)
    oauthError(
      OAuthErrorCode.InvalidScope,
      `The supported scope is ${MCP_SCOPE}.`,
    );
  const now = Date.now();
  const outcome = await mutateStore((state) => {
    const client = state.clients.find((candidate) => candidate.id === clientId);
    if (!client)
      oauthError(
        OAuthErrorCode.InvalidClient,
        "The OAuth client is unknown.",
        401,
      );
    const refresh = matchingToken(state.refreshTokens, "refresh", tokenValue);
    if (!refresh) {
      const replayedFamily = replayedRefreshFamily(
        state,
        tokenValue,
        clientId,
        resource,
      );
      if (replayedFamily) {
        const replayedGrant = state.grants.find(
          (candidate) => candidate.id === replayedFamily.grantId,
        );
        revokeTokenFamily(state, replayedFamily.id, now);
        return {
          replay: true as const,
          familyId: replayedFamily.id,
          grantId: replayedFamily.grantId,
          clientId: replayedGrant?.clientId,
          userId: replayedGrant?.userId,
        };
      }
      oauthError(OAuthErrorCode.InvalidGrant, "The refresh token is invalid.");
    }
    if (refresh.clientId !== clientId || refresh.resource !== resource)
      oauthError(OAuthErrorCode.InvalidGrant, "The refresh token is invalid.");
    const grant = state.grants.find(
      (candidate) =>
        candidate.id === refresh.grantId &&
        !candidate.revokedAt &&
        candidate.expiresAt > now,
    );
    if (!grant || refresh.expiresAt <= now)
      oauthError(OAuthErrorCode.InvalidGrant, "The connection has expired.");
    const family = state.refreshFamilies.find(
      (candidate) =>
        candidate.id === refresh.familyId && candidate.expiresAt > now,
    );
    if (!family)
      oauthError(OAuthErrorCode.InvalidGrant, "The refresh token is invalid.");
    consumeRefreshQuota(grant, now);
    addRefreshReplayTombstone(family, tokenValue);
    state.refreshTokens = state.refreshTokens.filter(
      (candidate) => candidate.id !== refresh.id,
    );
    client.lastUsedAt = now;
    return {
      replay: false as const,
      response: tokenResponse(
        issueTokenPair(
          state,
          grant,
          refresh.familyId,
          resource,
          [MCP_SCOPE],
          now,
        ),
      ),
    };
  });
  if (outcome.replay) {
    await audit("mcp.oauth.refresh_replay", "failure", {
      actor: outcome.userId,
      target: { type: "mcp-refresh-family", id: outcome.familyId },
      details: {
        connectionId: outcome.grantId,
        clientId: outcome.clientId,
      },
    });
    oauthError(
      OAuthErrorCode.InvalidGrant,
      "This refresh token was already used. Reconnect the client.",
    );
  }
  return outcome.response;
}

export async function exchangeMcpOAuthToken(
  params: URLSearchParams,
  urls: McpPublicUrls,
) {
  const grantType = exactlyOne(params, "grant_type");
  if (grantType === "authorization_code")
    return exchangeAuthorizationCode(params, urls);
  if (grantType === "refresh_token") return exchangeRefreshToken(params, urls);
  oauthError(
    OAuthErrorCode.UnsupportedGrantType,
    "Only authorization_code and refresh_token grants are supported.",
  );
}

export async function revokeMcpOAuthToken(params: URLSearchParams) {
  const clientId = assertTokenClient(params);
  const value = exactlyOne(params, "token");
  const hint = optionalOne(params, "token_type_hint");
  if (hint !== undefined && !["access_token", "refresh_token"].includes(hint))
    oauthError(
      OAuthErrorCode.UnsupportedTokenType,
      "The token type hint is not supported.",
    );
  const now = Date.now();
  const revoked = await mutateStore((state) => {
    const client = state.clients.find((candidate) => candidate.id === clientId);
    if (!client)
      oauthError(
        OAuthErrorCode.InvalidClient,
        "The OAuth client is unknown.",
        401,
      );
    const access = matchingToken(state.accessTokens, "access", value);
    if (access?.clientId === clientId && !access.revokedAt) {
      access.revokedAt = now;
      return {
        actorId: access.userId,
        targetType: "mcp-connection",
        targetId: access.grantId,
        connectionId: access.grantId,
        clientId,
        tokenType: "access" as const,
      };
    }
    const refresh = matchingToken(state.refreshTokens, "refresh", value);
    if (refresh?.clientId === clientId) {
      revokeTokenFamily(state, refresh.familyId, now);
      return {
        actorId: refresh.userId,
        targetType: "mcp-refresh-family",
        targetId: refresh.familyId,
        connectionId: refresh.grantId,
        clientId,
        tokenType: "refresh" as const,
      };
    }
    if (!refresh) {
      const family = state.refreshFamilies.find(
        (candidate) =>
          candidate.clientId === clientId &&
          replayedRefreshFamily(state, value, clientId, candidate.resource)
            ?.id === candidate.id,
      );
      const grant = family
        ? state.grants.find((candidate) => candidate.id === family.grantId)
        : undefined;
      if (family && grant?.clientId === clientId) {
        revokeTokenFamily(state, family.id, now);
        return {
          actorId: grant.userId,
          targetType: "mcp-refresh-family",
          targetId: family.id,
          connectionId: grant.id,
          clientId,
          tokenType: "refresh" as const,
        };
      }
    }
    return undefined;
  });
  if (revoked)
    await audit("mcp.oauth.token_revoked", "success", {
      actor: revoked.actorId,
      target: { type: revoked.targetType, id: revoked.targetId },
      details: {
        clientId: revoked.clientId,
        tokenType: revoked.tokenType,
        ...(revoked.connectionId ? { connectionId: revoked.connectionId } : {}),
      },
    });
}

type TokenSnapshot = {
  id: string;
  hash: string;
  grantId: string;
  clientId: string;
  username: string;
  userId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};

function invalidBearer(
  message = "The access token is invalid or expired.",
): never {
  throw new OAuthError(OAuthErrorCode.InvalidToken, message);
}

async function resolveLiveMcpActor(
  snapshot: TokenSnapshot,
): Promise<PanelActor> {
  const lookupSession: CloudPanelSession = {
    cookies: {},
    usernameHint: snapshot.username,
    cliAuthenticated: true,
  };
  let user: CloudPanelUser;
  try {
    user = await getCloudPanelClient().getCurrentUser(lookupSession);
  } catch {
    invalidBearer(
      "The Panelavo account for this connection is no longer active.",
    );
  }
  if (String(user.id) !== snapshot.userId || user.status === false)
    invalidBearer("The Panelavo account for this connection has changed.");
  return {
    user,
    cloudPanel: { ...lookupSession, usernameHint: user.username },
    authentication: "mcp",
    credentialId: snapshot.grantId,
  };
}

export const mcpTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(value) {
    const now = Date.now();
    const snapshot = await readStore((state): TokenSnapshot | undefined => {
      const token = matchingToken(state.accessTokens, "access", value);
      const grant = token
        ? state.grants.find((candidate) => candidate.id === token.grantId)
        : undefined;
      if (
        !token ||
        typeof token.clientId !== "string" ||
        typeof token.username !== "string" ||
        typeof token.userId !== "string" ||
        typeof token.resource !== "string" ||
        !Array.isArray(token.scopes) ||
        !token.scopes.every((scope) => typeof scope === "string") ||
        token.revokedAt ||
        token.expiresAt <= now ||
        !grant ||
        grant.revokedAt ||
        grant.expiresAt <= now
      )
        return undefined;
      return {
        id: token.id,
        hash: token.hash,
        grantId: token.grantId,
        clientId: token.clientId,
        username: token.username,
        userId: token.userId,
        resource: token.resource,
        scopes: [...token.scopes],
        expiresAt: token.expiresAt,
      };
    });
    if (!snapshot) invalidBearer();
    let resource: URL;
    try {
      resource = new URL(snapshot.resource);
    } catch {
      invalidBearer();
    }

    const actor = await resolveLiveMcpActor(snapshot);
    const confirmed = await mutateStore((state) => {
      const token = state.accessTokens.find(
        (candidate) =>
          candidate.id === snapshot.id &&
          typeof candidate.hash === "string" &&
          safeEqual(candidate.hash, snapshot.hash),
      );
      const grant = state.grants.find(
        (candidate) => candidate.id === snapshot.grantId,
      );
      if (
        !token ||
        token.revokedAt ||
        token.expiresAt <= Date.now() ||
        !grant ||
        grant.revokedAt ||
        grant.expiresAt <= Date.now()
      )
        return false;
      token.lastUsedAt = Date.now();
      token.username = actor.user.username;
      grant.lastUsedAt = token.lastUsedAt;
      grant.username = actor.user.username;
      return true;
    });
    if (!confirmed) invalidBearer();

    return {
      token: value,
      clientId: snapshot.clientId,
      scopes: snapshot.scopes,
      expiresAt: Math.floor(snapshot.expiresAt / 1000),
      resource,
      extra: { panelavoActor: actor },
    } satisfies AuthInfo;
  },
};

export function resolveMcpActor(authInfo: AuthInfo): PanelActor {
  const actor = authInfo.extra?.panelavoActor;
  if (
    !isRecord(actor) ||
    actor.authentication !== "mcp" ||
    !isRecord(actor.user) ||
    !isRecord(actor.cloudPanel)
  )
    invalidBearer(
      "The MCP request does not contain a resolved Panelavo account.",
    );
  return actor as unknown as PanelActor;
}

export async function authenticateMcpBearer(
  request: Request,
): Promise<{ authInfo: AuthInfo; actor: PanelActor } | Response> {
  let urls: McpPublicUrls;
  try {
    urls = getMcpPublicUrls(request);
  } catch {
    return bearerAuthChallengeResponse(
      new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Panelavo could not validate the public MCP address.",
      ),
    );
  }
  const authenticate = requireBearerAuth({
    verifier: mcpTokenVerifier,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: urls.resourceMetadataEndpoint,
  });
  const authInfo = await authenticate(request);
  if (authInfo instanceof Response) return authInfo;
  if (authInfo.resource?.toString() !== urls.resource)
    return bearerAuthChallengeResponse(
      new OAuthError(
        OAuthErrorCode.InvalidToken,
        "The access token was issued for a different MCP resource.",
      ),
      {
        requiredScopes: [MCP_SCOPE],
        resourceMetadataUrl: urls.resourceMetadataEndpoint,
      },
    );
  return { authInfo, actor: resolveMcpActor(authInfo) };
}

export async function listMcpConnections(
  userId: string,
  username: string,
): Promise<PublicMcpConnection[]> {
  const stableUserId = String(userId);
  const normalized = username.toLowerCase();
  const now = Date.now();
  return readStore((state) =>
    state.grants
      .filter(
        (grant) =>
          typeof grant.username === "string" &&
          grant.userId === stableUserId &&
          grant.username.toLowerCase() === normalized &&
          !grant.revokedAt &&
          grant.expiresAt > now,
      )
      .map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        expiresAt: grant.expiresAt,
      }))
      .sort(
        (left, right) =>
          (right.lastUsedAt ?? right.createdAt) -
          (left.lastUsedAt ?? left.createdAt),
      ),
  );
}

export async function revokeMcpConnection(
  userId: string,
  username: string,
  id: string,
) {
  const stableUserId = String(userId);
  const normalized = username.toLowerCase();
  const now = Date.now();
  await mutateStore((state) => {
    const grant = state.grants.find(
      (candidate) =>
        candidate.id === id &&
        candidate.userId === stableUserId &&
        typeof candidate.username === "string" &&
        candidate.username.toLowerCase() === normalized,
    );
    if (!grant) return;
    grant.revokedAt = now;
    revokeGrantTokens(state, grant.id, now);
    for (const code of state.authorizationCodes) {
      if (code.grantId === grant.id && !code.usedAt) code.usedAt = now;
    }
  });
}

export async function revokeAllMcpConnections(
  userId: string,
  username: string,
) {
  const stableUserId = String(userId);
  const normalized = username.toLowerCase();
  const now = Date.now();
  await mutateStore((state) => {
    state.authorizationRequests = state.authorizationRequests.filter(
      (request) =>
        request.userId !== stableUserId ||
        typeof request.username !== "string" ||
        request.username.toLowerCase() !== normalized,
    );
    for (const grant of state.grants) {
      if (
        grant.userId !== stableUserId ||
        typeof grant.username !== "string" ||
        grant.username.toLowerCase() !== normalized ||
        grant.revokedAt
      )
        continue;
      grant.revokedAt = now;
      revokeGrantTokens(state, grant.id, now);
      for (const code of state.authorizationCodes) {
        if (code.grantId === grant.id && !code.usedAt) code.usedAt = now;
      }
    }
  });
}

export function normalizeMcpAuthorizeReturnTo(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 6000)
    return undefined;
  try {
    const base = "https://panelavo.invalid";
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname !== "/oauth/authorize" || url.hash)
      return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

export function mcpAuthorizeReturnTo(params: URLSearchParams) {
  return normalizeMcpAuthorizeReturnTo(`/oauth/authorize?${params.toString()}`);
}

export async function clearMcpOAuthStoreForTests() {
  await mutateStore((state) => Object.assign(state, emptyStore()));
}
