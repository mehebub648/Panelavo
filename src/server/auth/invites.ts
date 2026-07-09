import { createHmac, timingSafeEqual } from "node:crypto";
import type { PanelRole } from "@/types/cloudpanel";
import { appSecret } from "./session";

// Stateless invitation links: a super admin defines the account (everything
// except the password) and the panel signs it into a compact JWT (HS256).
// Nothing is stored server-side — the account is created only when the invited
// person opens the link and chooses their password. Replay is harmless: once
// the user exists, creating it again fails.
export interface InvitePayload {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: PanelRole;
  sites: string[];
  timezone: string;
  invitedBy: string; // issuing super admin; redemption runs under their authority
  iat: number;
  exp: number;
}

export const INVITE_TTL_SECONDS = 24 * 60 * 60;

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(input: string) {
  return createHmac("sha256", appSecret()).update(input).digest("base64url");
}

export function createInviteToken(
  payload: Omit<InvitePayload, "iat" | "exp">,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: InvitePayload = { ...payload, iat: now, exp: now + INVITE_TTL_SECONDS };
  const head = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode(body);
  return `${head}.${claims}.${sign(`${head}.${claims}`)}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, claims, signature] = parts;
  const expected = Buffer.from(sign(`${head}.${claims}`));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(claims, "base64url").toString("utf8"),
    ) as InvitePayload;
    if (
      typeof payload.username !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp * 1000 < Date.now()
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}
