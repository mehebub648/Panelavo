import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SITE_CATEGORIES,
  allocateSiteId,
  changeSiteId,
  categoryById,
  getLinkedServiceMeta,
  getSiteMeta,
  nextFreeId,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  systemDomainFor,
} from "./site-meta";

describe("site meta", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "site-meta-"));
    process.env.PANEL_DATA_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("category ranges cover 20000-29999 without overlap", () => {
    const sorted = [...SITE_CATEGORIES].sort((a, b) => a.start - b.start);
    expect(sorted[0].start).toBe(20000);
    expect(sorted[sorted.length - 1].end).toBe(29999);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i].start).toBe(sorted[i - 1].end + 1);
  });

  it("builds system domains and site users from the id", () => {
    expect(siteUserForId(23223)).toBe("site-23223");
    expect(systemDomainFor(23223, "203.0.113.10", "Example.COM")).toBe(
      "site-23223.203.0.113.10.example.com",
    );
  });

  it("allocates the next free id in the requested category", async () => {
    const first = await allocateSiteId("friends");
    expect(first.id).toBe(23000);
    await setSiteMeta("site-23000.1.2.3.4.example.com", {
      id: 23000,
      category: "friends",
      aliases: [],
      block: "none",
    });
    const second = await allocateSiteId("friends", [23001]);
    expect(second.id).toBe(23002);
  });

  it("rejects unknown categories and reports exhaustion", async () => {
    await expect(allocateSiteId("nope")).rejects.toMatchObject({ status: 400 });
    const demo = categoryById("demo")!;
    const all = Array.from(
      { length: demo.end - demo.start + 1 },
      (_, index) => demo.start + index,
    );
    expect(nextFreeId(demo, all)).toBeNull();
    await expect(allocateSiteId("demo", all)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("stores, updates, and removes meta case-insensitively", async () => {
    await setSiteMeta("Site-20000.EXAMPLE.com", {
      id: 20000,
      category: "client",
      aliases: ["customer.com"],
      block: "redirect",
      redirectTo: "customer.com",
    });
    expect((await getSiteMeta("site-20000.example.COM"))?.aliases).toEqual([
      "customer.com",
    ]);
    await removeSiteMeta("SITE-20000.example.com");
    expect(await getSiteMeta("site-20000.example.com")).toBeNull();
  });

  it("lists linked services by parent domain, case-insensitively", async () => {
    await setSiteMeta("site-20000.example.com", {
      id: 20000,
      category: "client",
      aliases: [],
      block: "none",
    });
    await setSiteMeta("site-20001.example.com", {
      id: 20001,
      category: "client",
      aliases: ["api.customer.com"],
      block: "none",
      parent: "site-20000.example.com",
      serviceName: "api",
    });
    await setSiteMeta("site-20002.example.com", {
      id: 20002,
      category: "client",
      aliases: [],
      block: "none",
    });
    const services = await getLinkedServiceMeta("SITE-20000.example.COM");
    expect(Object.keys(services)).toEqual(["site-20001.example.com"]);
    expect(services["site-20001.example.com"].serviceName).toBe("api");
    expect(await getLinkedServiceMeta("site-20002.example.com")).toEqual({});
  });

  it("moves a reservation to a new port and re-categorizes it", async () => {
    await setSiteMeta("a.test", {
      id: 20000,
      category: "client",
      aliases: [],
      block: "none",
    });
    await setSiteMeta("b.test", {
      id: 21000,
      category: "personal",
      aliases: [],
      block: "none",
    });
    const moved = await changeSiteId("a.test", 25000);
    expect(moved).toMatchObject({ id: 25000, category: "internal" });
    await expect(changeSiteId("a.test", 21000)).rejects.toMatchObject({
      status: 409,
    });
    await expect(changeSiteId("a.test", 19999)).rejects.toMatchObject({
      status: 400,
    });
    await expect(changeSiteId("missing.test", 20001)).rejects.toMatchObject({
      status: 404,
    });
  });
});
