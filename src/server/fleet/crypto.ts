import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { AppError } from "@/server/cloudpanel/errors";
import {
  FLEET_PROTOCOL_VERSION,
  type FleetSignedEnvelope,
  type FleetSignedProtected,
} from "@/server/fleet/types";

const MAX_CLOCK_SKEW_SECONDS = 30;
const ENVELOPE_LIFETIME_SECONDS = 60;

export function generateFleetKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKey: pair.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
  };
}

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decoded<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export function createFleetEnvelope(
  payload: unknown,
  input: Omit<
    FleetSignedProtected,
    "alg" | "protocol" | "requestId" | "issuedAt" | "expiresAt"
  >,
  privateKey: string,
  now = Date.now(),
): FleetSignedEnvelope {
  const issuedAt = Math.floor(now / 1000);
  const protectedValue: FleetSignedProtected = {
    ...input,
    alg: "Ed25519",
    protocol: FLEET_PROTOCOL_VERSION,
    requestId: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + ENVELOPE_LIFETIME_SECONDS,
  };
  const protectedPart = encoded(protectedValue);
  const payloadPart = encoded(payload ?? null);
  const signature = sign(
    null,
    Buffer.from(`${protectedPart}.${payloadPart}`, "utf8"),
    createPrivateKey(privateKey),
  ).toString("base64url");
  return { protected: protectedPart, payload: payloadPart, signature };
}

export function verifyFleetEnvelope<T>(
  envelope: FleetSignedEnvelope,
  publicKey: string,
  expected: Partial<
    Pick<
      FleetSignedProtected,
      "typ" | "connectionId" | "issuerId" | "audienceId" | "action"
    >
  >,
  now = Date.now(),
) {
  if (
    !envelope ||
    typeof envelope.protected !== "string" ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    envelope.protected.length > 16_384 ||
    envelope.payload.length > 12 * 1024 * 1024 ||
    envelope.signature.length > 512
  )
    throw new AppError(
      "FORBIDDEN",
      "The federation signature is invalid.",
      401,
    );
  let protectedValue: FleetSignedProtected;
  let payload: T;
  try {
    protectedValue = decoded<FleetSignedProtected>(envelope.protected);
    payload = decoded<T>(envelope.payload);
  } catch {
    throw new AppError("FORBIDDEN", "The federation envelope is invalid.", 401);
  }
  const validSignature = verify(
    null,
    Buffer.from(`${envelope.protected}.${envelope.payload}`, "utf8"),
    createPublicKey(publicKey),
    Buffer.from(envelope.signature, "base64url"),
  );
  if (!validSignature)
    throw new AppError(
      "FORBIDDEN",
      "The federation signature is invalid.",
      401,
    );
  const seconds = Math.floor(now / 1000);
  if (
    protectedValue.alg !== "Ed25519" ||
    protectedValue.protocol !== FLEET_PROTOCOL_VERSION ||
    protectedValue.issuedAt > seconds + MAX_CLOCK_SKEW_SECONDS ||
    protectedValue.expiresAt < seconds - MAX_CLOCK_SKEW_SECONDS ||
    protectedValue.expiresAt - protectedValue.issuedAt >
      ENVELOPE_LIFETIME_SECONDS ||
    !/^[0-9a-f-]{36}$/.test(protectedValue.requestId)
  )
    throw new AppError(
      "FORBIDDEN",
      "The federation request expired or is incompatible.",
      401,
    );
  for (const [key, value] of Object.entries(expected)) {
    if (
      value !== undefined &&
      protectedValue[key as keyof FleetSignedProtected] !== value
    )
      throw new AppError(
        "FORBIDDEN",
        "The federation request target is invalid.",
        401,
      );
  }
  return { protected: protectedValue, payload };
}
