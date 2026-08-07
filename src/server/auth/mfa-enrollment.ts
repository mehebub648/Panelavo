import { randomBytes } from "node:crypto";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";

type PendingEnrollment = { secret: string; expiresAt: number };
type Store = { users: Record<string, PendingEnrollment> };

const pending = encryptedJsonStore<Store>("mfa-enrollments.enc", () => ({
  users: {},
}));
const TTL_MS = 10 * 60_000;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(value: Buffer) {
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5)
    output +=
      alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return output;
}

export async function beginMfaEnrollment(username: string) {
  const store = await pending.load();
  const secret = base32(randomBytes(20));
  store.users[username] = { secret, expiresAt: Date.now() + TTL_MS };
  await pending.save(store);
  return secret;
}

export async function getMfaEnrollment(username: string) {
  const store = await pending.load();
  const enrollment = store.users[username];
  if (!enrollment || enrollment.expiresAt <= Date.now()) {
    if (enrollment) {
      delete store.users[username];
      await pending.save(store);
    }
    return null;
  }
  return enrollment.secret;
}

export async function clearMfaEnrollment(username: string) {
  const store = await pending.load();
  delete store.users[username];
  await pending.save(store);
}
