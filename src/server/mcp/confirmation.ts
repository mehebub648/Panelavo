import { createHmac, randomUUID } from "node:crypto";
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod4";
import { appSecret } from "@/server/auth/session";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { jsonStore } from "@/server/storage/json-store";

const CONFIRMATION_TTL_SECONDS = 2 * 60;
const MAX_PENDING_PER_ACTOR = 100;
const MAX_PENDING_PER_CREDENTIAL = 25;
const MAX_PENDING_TOTAL = 5_000;

const confirmationStateSchema = z
  .object({
    version: z.literal(1),
    tool: z.string().min(1).max(100),
    argumentsDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    nonce: z.uuid(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

type ConfirmationState = z.infer<typeof confirmationStateSchema>;

type PendingConfirmation = ConfirmationState & {
  actorId: string;
  credentialId: string;
  createdAt: number;
};

const pendingConfirmationSchema = confirmationStateSchema.extend({
  actorId: z.string().min(1).max(200),
  credentialId: z.string().min(1).max(200),
  createdAt: z.number().int().positive(),
});

type ConfirmationStore = {
  pending: PendingConfirmation[];
};

export type McpConfirmationRequest = {
  context: ServerContext;
  tool: string;
  arguments: unknown;
  message: string;
  confirmationPhrase?: string;
};

function emptyStore(): ConfirmationStore {
  return { pending: [] };
}

function normalizeStore(value: unknown): ConfirmationStore {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return emptyStore();
  const pending = (value as { pending?: unknown }).pending;
  return {
    pending: Array.isArray(pending)
      ? pending.filter(
          (item): item is PendingConfirmation =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as PendingConfirmation).actorId === "string" &&
            typeof (item as PendingConfirmation).credentialId === "string" &&
            typeof (item as PendingConfirmation).createdAt === "number" &&
            pendingConfirmationSchema.safeParse(item).success,
        )
      : [],
  };
}

const confirmationStore = jsonStore<ConfirmationStore>(
  "mcp-confirmations.json",
  emptyStore,
  normalizeStore,
);

const globalConfirmationState = globalThis as typeof globalThis & {
  __panelMcpConfirmationMutation?: Promise<void>;
};
globalConfirmationState.__panelMcpConfirmationMutation ??= Promise.resolve();

function sweep(store: ConfirmationStore, now = Date.now()) {
  store.pending = store.pending.filter(
    (confirmation) => confirmation.expiresAt > now,
  );
}

async function mutateStore<T>(
  operation: (store: ConfirmationStore) => T | Promise<T>,
) {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const queued = globalConfirmationState.__panelMcpConfirmationMutation!.then(
    async () => {
      try {
        const store = await confirmationStore.load();
        sweep(store);
        const value = await operation(store);
        await confirmationStore.save(store);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    },
  );
  globalConfirmationState.__panelMcpConfirmationMutation = queued.catch(
    () => undefined,
  );
  return result;
}

function actorBinding(actor: PanelActor) {
  const actorId = String(actor.user.id ?? "").trim();
  const credentialId = String(actor.credentialId ?? "").trim();
  if (actor.authentication !== "mcp" || !actorId || !credentialId)
    throw new AppError(
      "FORBIDDEN",
      "This confirmation is not attached to an active AI connection.",
      403,
    );
  return { actorId, credentialId };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

export function mcpConfirmationArgumentsDigest(value: unknown) {
  return createHmac("sha256", appSecret())
    .update("panelavo:mcp-confirmation-arguments:v1\0")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("base64url");
}

function stateKey() {
  return createHmac("sha256", appSecret())
    .update("panelavo:mcp-confirmation-state:v1")
    .digest();
}

async function registerPending(confirmation: PendingConfirmation) {
  await mutateStore((store) => {
    const actorPending = store.pending.filter(
      (item) => item.actorId === confirmation.actorId,
    ).length;
    const credentialPending = store.pending.filter(
      (item) => item.credentialId === confirmation.credentialId,
    ).length;
    if (
      actorPending >= MAX_PENDING_PER_ACTOR ||
      credentialPending >= MAX_PENDING_PER_CREDENTIAL
    )
      throw new AppError(
        "OPERATION_BUSY",
        "Too many website confirmations are waiting for this AI connection.",
        429,
      );
    if (store.pending.length >= MAX_PENDING_TOTAL)
      throw new AppError(
        "OPERATION_BUSY",
        "Panelavo cannot start another website confirmation right now.",
        503,
      );
    store.pending.push(confirmation);
  });
}

async function consumePending(expected: PendingConfirmation, now = Date.now()) {
  await mutateStore((store) => {
    const index = store.pending.findIndex(
      (item) =>
        item.nonce === expected.nonce &&
        item.actorId === expected.actorId &&
        item.credentialId === expected.credentialId &&
        item.tool === expected.tool &&
        item.argumentsDigest === expected.argumentsDigest &&
        item.expiresAt === expected.expiresAt,
    );
    if (index < 0 || expected.expiresAt <= now)
      throw new AppError(
        "INVALID_REQUEST",
        "This website confirmation expired or was already used.",
        409,
      );
    store.pending.splice(index, 1);
  });
}

export function createMcpConfirmationManager(actor: PanelActor) {
  const binding = actorBinding(actor);
  const codec = createRequestStateCodec<ConfirmationState>({
    key: stateKey(),
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    bind(context) {
      const clientId = context.http?.authInfo?.clientId?.trim();
      if (!clientId)
        throw new Error("MCP confirmation is missing its OAuth client.");
      return [
        "panelavo:mcp-confirmation:v1",
        context.mcpReq.method,
        binding.actorId,
        binding.credentialId,
        clientId,
      ].join("\0");
    },
  });

  return {
    verifyRequestState: codec.verify,
    async require({
      context,
      tool,
      arguments: toolArguments,
      message,
      confirmationPhrase,
    }: McpConfirmationRequest) {
      const argumentsDigest = mcpConfirmationArgumentsDigest(toolArguments);
      const response = inputResponse(
        context.mcpReq.inputResponses,
        "panelavo_confirmation",
      );
      if (response.kind === "elicit") {
        if (response.action !== "accept")
          throw new AppError(
            "INVALID_REQUEST",
            "The user did not approve this website action.",
            409,
          );
        if (
          response.content?.confirm !== true ||
          (confirmationPhrase !== undefined &&
            response.content.confirmation !== confirmationPhrase)
        )
          throw new AppError(
            "INVALID_REQUEST",
            "The website action was not confirmed correctly.",
            409,
          );
        const parsed = confirmationStateSchema.safeParse(
          context.mcpReq.requestState<unknown>(),
        );
        if (
          !parsed.success ||
          parsed.data.tool !== tool ||
          parsed.data.argumentsDigest !== argumentsDigest ||
          parsed.data.expiresAt <= Date.now()
        )
          throw new AppError(
            "INVALID_REQUEST",
            "This confirmation does not match the requested website action.",
            409,
          );
        await consumePending({
          ...parsed.data,
          ...binding,
          createdAt: parsed.data.expiresAt - CONFIRMATION_TTL_SECONDS * 1000,
        });
        return undefined;
      }
      if (response.kind !== "missing")
        throw new AppError(
          "INVALID_REQUEST",
          "Panelavo received an invalid confirmation response.",
          400,
        );
      if (context.mcpReq.requestState<unknown>() !== undefined)
        throw new AppError(
          "INVALID_REQUEST",
          "Panelavo did not receive the requested confirmation response.",
          400,
        );

      const now = Date.now();
      const state: ConfirmationState = {
        version: 1,
        tool,
        argumentsDigest,
        nonce: randomUUID(),
        expiresAt: now + CONFIRMATION_TTL_SECONDS * 1000,
      };
      const requestState = await codec.mint(state, context);
      await registerPending({ ...state, ...binding, createdAt: now });

      const requestedSchema = {
        type: "object" as const,
        properties: {
          confirm: {
            type: "boolean" as const,
            title: "Approve this action",
            description: "Select true only if you want Panelavo to continue.",
          },
          ...(confirmationPhrase
            ? {
                confirmation: {
                  type: "string" as const,
                  title: `Type ${confirmationPhrase} exactly`,
                  description:
                    "Type the exact value shown above to confirm this action.",
                },
              }
            : {}),
        },
        required: confirmationPhrase
          ? (["confirm", "confirmation"] as string[])
          : (["confirm"] as string[]),
      };
      return inputRequired({
        inputRequests: {
          panelavo_confirmation: inputRequired.elicit({
            message,
            requestedSchema,
          }),
        },
        requestState,
      });
    },
  };
}

export async function clearMcpConfirmationStoreForTests() {
  await mutateStore((store) => {
    store.pending = [];
  });
}
