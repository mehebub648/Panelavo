import { describe, expect, it } from "vitest";
import { auditQueryFromSearchParams } from "./audit-query";

describe("auditQueryFromSearchParams", () => {
  it("maps UI filters and expands date boundaries", () => {
    const query = auditQueryFromSearchParams(
      new URLSearchParams({
        page: "2",
        pageSize: "500",
        user: "admin",
        site: "example.com",
        action: "sites.",
        result: "failure",
        from: "2026-08-01",
        to: "2026-08-07",
      }),
    );

    expect(query).toEqual({
      page: 2,
      pageSize: 100,
      actor: "admin",
      target: "example.com",
      action: "sites.",
      result: "failure",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-07T23:59:59.999Z",
    });
  });

  it("falls back safely for invalid pagination and result values", () => {
    expect(
      auditQueryFromSearchParams(
        new URLSearchParams({ page: "-1", pageSize: "nope", result: "all" }),
      ),
    ).toMatchObject({ page: 1, pageSize: 25, result: undefined });
  });
});
