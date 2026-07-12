import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audit,
  auditContext,
  readAuditEvents,
  redact,
  resetAuditQueueForTests,
} from "./log";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "panelavo-audit-"));
  process.env.PANEL_DATA_DIR = directory;
  process.env.PANEL_AUDIT_MAX_BYTES = "20000";
  process.env.PANEL_AUDIT_MAX_FILES = "3";
  resetAuditQueueForTests();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PANEL_DATA_DIR;
  delete process.env.PANEL_AUDIT_MAX_BYTES;
  delete process.env.PANEL_AUDIT_MAX_FILES;
  await rm(directory, { recursive: true, force: true });
});

describe("log redaction", () => {
  it("redacts nested authentication secrets case-insensitively", () => {
    expect(
      redact({
        user: "admin",
        Password: "secret",
        nested: {
          MFA_CODE: "123456",
          apiToken: "abc",
          privateKeyMasked: "key",
          errorCode: "INVALID_REQUEST",
          publicKey: "ssh-ed25519 public",
        },
      }),
    ).toEqual({
      user: "admin",
      Password: "[REDACTED]",
      nested: {
        MFA_CODE: "[REDACTED]",
        apiToken: "[REDACTED]",
        privateKeyMasked: "[REDACTED]",
        errorCode: "INVALID_REQUEST",
        publicKey: "ssh-ed25519 public",
      },
    });
  });

  it("builds structured actor, request, client, target, and safe error context", () => {
    const request = new Request("https://panel.example.test/api/sites/test", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.8, 127.0.0.1",
        "user-agent": "test-agent",
      },
    });
    expect(
      auditContext({
        request,
        actor: { id: "1", username: "admin", role: "admin" },
        target: { type: "site", id: "example.test" },
        error: Object.assign(new Error("secret detail"), {
          code: "INVALID_REQUEST",
          status: 400,
        }),
      }),
    ).toMatchObject({
      actor: { id: "1", username: "admin", role: "admin" },
      target: { type: "site", id: "example.test" },
      request: { method: "POST", path: "/api/sites/test" },
      client: { address: "203.0.113.8", userAgent: "test-agent" },
      details: {
        errorName: "Error",
        errorCode: "INVALID_REQUEST",
        errorStatus: 400,
      },
    });
  });
});

describe("audit ledger", () => {
  it("serializes concurrent events into a valid hash chain", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        audit(
          "sites.section",
          index % 2 ? "success" : "failure",
          auditContext({
            actor: { username: `user-${index % 3}`, role: "admin" },
            target: { type: "site", id: `site-${index}` },
            details: { operation: "save", password: "never-store-this" },
          }),
        ),
      ),
    );

    const page = await readAuditEvents({ pageSize: 100 });
    expect(page.pagination.total).toBe(20);
    expect(page.integrity).toMatchObject({ valid: true, checkedEvents: 20 });
    expect(JSON.stringify(page.events)).not.toContain("never-store-this");
    expect(page.events.every((event) => event.hash.length === 64)).toBe(true);
  });

  it("filters and paginates newest-first", async () => {
    await audit("users.add", "success", auditContext({ actor: "admin" }));
    await audit("sites.delete", "failure", auditContext({ actor: "operator" }));
    await audit("sites.update", "success", auditContext({ actor: "admin" }));

    const first = await readAuditEvents({
      action: "sites",
      result: "success",
      page: 1,
      pageSize: 1,
    });
    expect(first.pagination).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(first.events[0].action).toBe("sites.update");

    const actor = await readAuditEvents({ actor: "operator" });
    expect(actor.events.map((event) => event.action)).toEqual(["sites.delete"]);
  });

  it("rotates to a bounded number of files while keeping the retained chain valid", async () => {
    process.env.PANEL_AUDIT_MAX_BYTES = "700";
    for (let index = 0; index < 12; index += 1)
      await audit("rotation.test", "success", {
        index,
        detail: "x".repeat(300),
      });

    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(directory, "audit")),
    );
    const ledgers = names.filter((name) => name.endsWith(".jsonl"));
    expect(ledgers.length).toBeLessThanOrEqual(3);
    const page = await readAuditEvents({ pageSize: 100 });
    expect(page.integrity.valid).toBe(true);
    expect(page.pagination.total).toBeGreaterThan(0);
    expect(page.pagination.total).toBeLessThan(12);
  });

  it("detects modified retained records", async () => {
    await audit("security.change", "success", auditContext({ actor: "admin" }));
    const file = join(directory, "audit", "audit.jsonl");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("security.change", "security.changE"));

    const page = await readAuditEvents();
    expect(page.integrity.valid).toBe(false);
    expect(page.integrity.issues.join(" ")).toContain("content hash");
  });
});
