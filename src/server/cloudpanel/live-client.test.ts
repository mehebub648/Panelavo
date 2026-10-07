import { describe, expect, it } from "vitest";
import {
  createdSiteFromBridge,
  privilegedErrorMessage,
  siteUpdateErrorMessage,
  siteSectionBridgeError,
  siteSectionTimeout,
  vpnBridgeError,
} from "./live-client";

describe("createdSiteFromBridge", () => {
  it("keeps the authoritative CloudPanel site identity", () => {
    const site = createdSiteFromBridge(
      {
        site: {
          id: "23001",
          domain: "example.test",
          type: "php",
          url: "https://example.test",
        },
      },
      "EXAMPLE.TEST",
    );

    expect(site.id).toBe("23001");
  });

  it("rejects a creation response without a matching site", () => {
    expect(() => createdSiteFromBridge({}, "example.test")).toThrow(
      "created website identity",
    );
    expect(() =>
      createdSiteFromBridge(
        {
          site: {
            id: "23001",
            domain: "other.test",
            url: "https://other.test",
          },
        },
        "example.test",
      ),
    ).toThrow("created website identity");
  });
});

describe("siteSectionTimeout", () => {
  it("keeps the bounded timeout policy explicit", () => {
    expect(siteSectionTimeout("actions")).toBe(1_850_000);
    expect(siteSectionTimeout("backups")).toBe(1_850_000);
    expect(siteSectionTimeout("file-manager")).toBe(620_000);
    expect(siteSectionTimeout("git")).toBe(300_000);
    expect(siteSectionTimeout("terminal")).toBe(200_000);
    expect(siteSectionTimeout("env")).toBe(60_000);
    expect(siteSectionTimeout("domains")).toBeUndefined();
  });
});

describe("siteSectionBridgeError", () => {
  it("returns the file-manager upload limit", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "UPLOAD_TOO_LARGE",
    });
    expect(error.status).toBe(413);
    expect(error.message).toContain("64 MiB");
  });

  it("explains a non-empty clone target", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "DIRECTORY_NOT_EMPTY",
    });
    expect(error.status).toBe(409);
    expect(error.message).toContain("preserve them before cloning");
    expect(error.message).not.toContain("remove the existing files");
  });

  it("turns Git authentication output into a safe action", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "GIT_FAILED",
      message: "git@github.com: Permission denied (publickey).",
    });
    expect(error.status).toBe(422);
    expect(error.message).toContain("public deployment key");
    expect(error.message).not.toContain("git@github.com");
  });

  it("reports a concurrent operation as a retryable conflict", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "OPERATION_BUSY",
    });
    expect(error.status).toBe(409);
    expect(error.message).toContain("already running");
  });

  it.each([
    ["error: Your local changes would be overwritten by checkout", "protect your local files"],
    ["fatal: Not possible to fast-forward, aborting.", "different commits"],
    ["fatal: The current branch main has no upstream branch", "no usable upstream"],
    ["error: you need to resolve your current index first", "conflict recovery"],
    ["fatal: unable to auto-detect email address", "commit identity"],
    ["fatal: ambiguous argument 'HEAD': unknown revision", "no first commit"],
    ["Host key verification failed.", "published fingerprint"],
    ["fatal: Could not resolve host: example.test", "could not reach"],
    ["fatal: invalid reference: missing", "choose an available branch"],
  ])("classifies %s without exposing command output", (message, recovery) => {
    const error = siteSectionBridgeError({ ok: false, code: "GIT_FAILED", message });
    expect(error.message).toContain(recovery);
    expect(error.message).not.toContain("fatal:");
  });

  it("surfaces the bridge's specific reason for a failed change", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "SITE_UPDATE_FAILED",
      message: 'Database export failed for "app": clpctl error',
    });
    expect(error.status).toBe(502);
    expect(error.message).toContain("Database export failed");
  });

  it("falls back to a generic message when the bridge sends no detail", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "SITE_UPDATE_FAILED",
    });
    expect(error.status).toBe(502);
    expect(error.message).toBe("The server could not apply the change.");
  });

  it("does not expose unsafe Compose details returned by the bridge", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "UNSAFE_COMPOSE",
      message: "bind mount /etc/shadow",
    });
    expect(error.status).toBe(422);
    expect(error.message).toContain("host safety policy");
    expect(error.message).not.toContain("/etc/shadow");
  });
});

describe("privilegedErrorMessage", () => {
  it("keeps SSL validation errors specific instead of mapping to db-name rules", () => {
    expect(
      privilegedErrorMessage(
        "Validation failed for one or more domains while issuing the certificate.",
        "The server could not install the certificate.",
      ),
    ).toBe("The server could not install the certificate.");
  });

  it("maps database identifier validation errors to the expected guidance", () => {
    expect(
      privilegedErrorMessage(
        "databaseUserName is not valid",
        "The server could not create the database.",
      ),
    ).toBe(
      "Use 2–50 characters, starting with a letter and containing only letters, numbers, and hyphens.",
    );
  });
});

describe("siteUpdateErrorMessage", () => {
  const fallback = "The server could not update the website.";

  it("surfaces safe port ownership and reservation details", () => {
    expect(
      siteUpdateErrorMessage(
        {
          code: "INVALID_REQUEST",
          message: "Port 31001 is reserved by another CloudPanel website.",
        },
        fallback,
      ),
    ).toBe("Port 31001 is reserved by another CloudPanel website.");
    expect(
      siteUpdateErrorMessage(
        {
          code: "INVALID_REQUEST",
          message:
            "Port 31001 is listening, but it is not a loopback listener owned by this project.",
        },
        fallback,
      ),
    ).toContain("not a loopback listener owned by this project");
  });

  it("explains whether a failed upstream change was restored", () => {
    expect(
      siteUpdateErrorMessage(
        {
          code: "INVALID_REQUEST",
          message:
            "The selected upstream stopped responding while CloudPanel was updated. The previous proxy setting was restored.",
        },
        fallback,
      ),
    ).toContain("previous proxy setting was restored");
    expect(
      siteUpdateErrorMessage(
        {
          code: "BRIDGE_FAILED",
          message:
            "The selected upstream stopped responding, and Panelavo could not restore the previous proxy setting automatically.",
        },
        fallback,
      ),
    ).toContain("could not restore");
  });

  it("keeps unexpected bridge output behind the generic error", () => {
    expect(
      siteUpdateErrorMessage(
        {
          code: "BRIDGE_FAILED",
          message: "Failed while reading /etc/shadow: secret output",
        },
        fallback,
      ),
    ).toBe(fallback);
    expect(
      siteUpdateErrorMessage(
        {
          code: "BRIDGE_FAILED",
          message: "Port 31001 is reserved by another CloudPanel website.",
        },
        fallback,
      ),
    ).toBe(fallback);
  });
});

describe("vpnBridgeError", () => {
  it("keeps conflicts actionable without exposing arbitrary broker output", () => {
    const conflict = vpnBridgeError({
      ok: false,
      code: "VPN_CONFLICT",
      message: "UDP port 51820 is already in use.",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.message).toContain("51820");

    const failure = vpnBridgeError({
      ok: false,
      code: "BRIDGE_FAILED",
      message: "",
    });
    expect(failure.status).toBe(502);
    expect(failure.message).toBe("The server could not apply the VPN change.");
  });
});
