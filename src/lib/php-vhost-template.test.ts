import { describe, expect, it } from "vitest";
import { defaultPhpVhostTemplate } from "./php-vhost-template";

describe("defaultPhpVhostTemplate", () => {
  it("prefers the exact Generic template over alphabetical order", () => {
    expect(defaultPhpVhostTemplate(["CakePHP", "Generic", "Laravel 11"])).toBe(
      "Generic",
    );
  });

  it("recognizes descriptive generic PHP template names", () => {
    expect(
      defaultPhpVhostTemplate(["Laravel", "Generic PHP Application", "Symfony"]),
    ).toBe("Generic PHP Application");
  });

  it("keeps the server order when no generic template exists", () => {
    expect(defaultPhpVhostTemplate(["Laravel", "Symfony"])).toBe("Laravel");
    expect(defaultPhpVhostTemplate([])).toBe("");
  });
});
