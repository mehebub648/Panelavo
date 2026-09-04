import { describe, expect, it } from "vitest";
import {
  createFleetEnvelope,
  generateFleetKeyPair,
  verifyFleetEnvelope,
} from "./crypto";

const protectedFields = {
  typ: "panelavo-federation-request+json" as const,
  connectionId: "0f988ab4-dd94-47c3-bf0e-e4ae39fc453e",
  issuerId: "81fb70b8-18f8-43d5-8812-943255228dad",
  audienceId: "7cd8be3c-4383-468c-a53b-023de187056e",
  actorId: "owner-1",
  actorUsername: "owner",
  action: "system.summary",
};

describe("Fleet signed envelopes", () => {
  it("verifies a content-covered Ed25519 request", () => {
    const keys = generateFleetKeyPair();
    const envelope = createFleetEnvelope(
      { value: 42 },
      protectedFields,
      keys.privateKey,
      1_000_000,
    );
    expect(
      verifyFleetEnvelope<{ value: number }>(
        envelope,
        keys.publicKey,
        protectedFields,
        1_000_000,
      ).payload.value,
    ).toBe(42);
  });

  it("rejects altered bodies, wrong peers, algorithms, and expired requests", () => {
    const keys = generateFleetKeyPair();
    const envelope = createFleetEnvelope(
      { value: 42 },
      protectedFields,
      keys.privateKey,
      1_000_000,
    );
    expect(() =>
      verifyFleetEnvelope(
        {
          ...envelope,
          payload: Buffer.from(JSON.stringify({ value: 43 })).toString(
            "base64url",
          ),
        },
        keys.publicKey,
        protectedFields,
        1_000_000,
      ),
    ).toThrow(/signature/i);
    expect(() =>
      verifyFleetEnvelope(
        envelope,
        keys.publicKey,
        { ...protectedFields, audienceId: "wrong" },
        1_000_000,
      ),
    ).toThrow(/target/i);
    const decoded = JSON.parse(
      Buffer.from(envelope.protected, "base64url").toString("utf8"),
    );
    decoded.alg = "RS256";
    expect(() =>
      verifyFleetEnvelope(
        {
          ...envelope,
          protected: Buffer.from(JSON.stringify(decoded)).toString("base64url"),
        },
        keys.publicKey,
        protectedFields,
        1_000_000,
      ),
    ).toThrow(/signature/i);
    expect(() =>
      verifyFleetEnvelope(envelope, keys.publicKey, protectedFields, 1_200_000),
    ).toThrow(/expired/i);
  });
});
