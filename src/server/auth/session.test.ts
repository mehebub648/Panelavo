import { beforeEach, expect, it, vi } from "vitest";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { getSecuritySettings } from "@/server/settings/store";
import {
  clearSessionStoreForTests,
  listUserSessions,
  revokeUserSession,
  updateSession,
} from "./session";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/server/settings/store", () => ({ getSecuritySettings: vi.fn() }));
const record = () => ({
  cloudPanel: { cookies: {}, usernameHint: "alice" },
  expiresAt: Date.now() + 60_000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  clearSessionStoreForTests();
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({ one: record(), two: record() }),
  );
  vi.mocked(getSecuritySettings).mockResolvedValue({
    sessionLifetimeMinutes: 60,
  } as Awaited<ReturnType<typeof getSecuritySettings>>);
});

it("makes concurrent readers wait for the same initial disk load", async () => {
  const read = deferred<string>();
  vi.mocked(readFile).mockReturnValue(read.promise);
  const first = listUserSessions("alice", "one");
  const second = listUserSessions("alice", "one");
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(readFile).toHaveBeenCalledTimes(1);
  read.resolve(JSON.stringify({ one: record() }));
  expect(await first).toHaveLength(1);
  expect(await second).toHaveLength(1);
});

it("orders disk writes so a pending older snapshot cannot undo revocation", async () => {
  await listUserSessions("alice", "one");
  const write = deferred<void>();
  vi.mocked(writeFile).mockReturnValueOnce(write.promise);
  const first = updateSession("one", {});
  await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
  const second = revokeUserSession("alice", "one", "two");
  await Promise.resolve();
  expect(writeFile).toHaveBeenCalledTimes(1);
  write.resolve();
  await Promise.all([first, second]);
  expect(rename).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(String(vi.mocked(writeFile).mock.calls[1][1]));
  expect(saved.one).toBeUndefined();
  expect(saved.two).toBeDefined();
});

it("does not resurrect a session revoked while its refresh was waiting", async () => {
  await listUserSessions("alice", "one");
  const settings = deferred<Awaited<ReturnType<typeof getSecuritySettings>>>();
  vi.mocked(getSecuritySettings).mockReturnValueOnce(settings.promise);
  const refreshing = updateSession("one", {});
  await vi.waitFor(() => expect(getSecuritySettings).toHaveBeenCalled());
  await revokeUserSession("alice", "one", "two");
  settings.resolve({ sessionLifetimeMinutes: 60 } as Awaited<
    ReturnType<typeof getSecuritySettings>
  >);
  await refreshing;
  expect((await listUserSessions("alice", "two")).map((s) => s.id)).toEqual([
    "two",
  ]);
});

it("cleans failed writes and retries persistence on the next refresh", async () => {
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk unavailable"));
  await updateSession("one", {});
  await updateSession("one", {});
  expect(rm).toHaveBeenCalledTimes(1);
  expect(rename).toHaveBeenCalledTimes(2);
});
