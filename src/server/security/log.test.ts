import { describe, expect, it } from "vitest";
import { redact } from "./log";

describe("log redaction", () => {
  it("redacts nested authentication secrets", () => {
    expect(
      redact({
        user: "admin",
        password: "secret",
        nested: { code: "123456", cookie: "abc" },
      }),
    ).toEqual({
      user: "admin",
      password: "[REDACTED]",
      nested: { code: "[REDACTED]", cookie: "[REDACTED]" },
    });
  });
});
