import { describe, expect, it } from "vitest";
import { offsiteDestinationSchema } from "./offsite";

describe("off-site backup destination", () => {
  const valid = {
    enabled: true,
    endpoint: "https://s3.example.com",
    region: "auto",
    bucket: "panelavo-backups",
    prefix: "production/sites",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: true,
  };

  it("accepts bounded S3-compatible settings", () => {
    expect(offsiteDestinationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects plaintext endpoints and traversal-like prefixes", () => {
    expect(() =>
      offsiteDestinationSchema.parse({ ...valid, endpoint: "http://s3.example.com" }),
    ).toThrow();
    expect(() =>
      offsiteDestinationSchema.parse({ ...valid, prefix: "../outside" }),
    ).toThrow();
  });
});
