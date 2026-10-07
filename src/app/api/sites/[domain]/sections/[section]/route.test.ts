import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/cloudpanel/errors";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  panelActorFromSession: vi.fn(),
  writableSiteForActor: vi.fn(),
  getSiteSectionForActor: vi.fn(),
  manageSiteSectionForActor: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/auth/site-access", () => ({
  panelActorFromSession: dependencies.panelActorFromSession,
  writableSiteForActor: dependencies.writableSiteForActor,
}));
vi.mock("@/server/sites/site-section-service", () => ({
  getSiteSectionForActor: dependencies.getSiteSectionForActor,
  manageSiteSectionForActor: dependencies.manageSiteSectionForActor,
}));

import { GET } from "./route";

const session = {
  id: "session-1",
  user: { id: "user-1", username: "manager" },
  record: { cloudPanel: { usernameHint: "manager" } },
};
const actor = {
  user: session.user,
  cloudPanel: session.record.cloudPanel,
  authentication: "session",
};

function get(section: string, domain = "example.test") {
  return GET(
    new NextRequest(
      `https://panel.example.test/api/sites/${domain}/sections/${section}`,
    ),
    { params: Promise.resolve({ domain, section }) },
  );
}

describe("browser website section reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.requireUser.mockResolvedValue(session);
    dependencies.panelActorFromSession.mockReturnValue(actor);
    dependencies.writableSiteForActor.mockResolvedValue({});
    dependencies.getSiteSectionForActor.mockResolvedValue({ branch: "main" });
  });

  it("requires an authenticated browser session", async () => {
    dependencies.requireUser.mockRejectedValue(
      new AppError("SESSION_EXPIRED", "Sign in again.", 401),
    );

    const response = await get("git");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "SESSION_EXPIRED", message: "Sign in again." },
    });
    expect(dependencies.getSiteSectionForActor).not.toHaveBeenCalled();
  });

  it("decodes the domain and lets a read-only user inspect Git", async () => {
    const response = await get("git", "example%2Etest");

    expect(response.status).toBe(200);
    expect(dependencies.panelActorFromSession).toHaveBeenCalledWith(session);
    expect(dependencies.writableSiteForActor).not.toHaveBeenCalled();
    expect(dependencies.getSiteSectionForActor).toHaveBeenCalledWith(
      actor,
      "example.test",
      "git",
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { branch: "main" },
    });
  });

  it.each(["users", "logs", "cron-jobs"])(
    "requires website-write access before reading %s",
    async (section) => {
      await get(section);

      expect(dependencies.writableSiteForActor).toHaveBeenCalledWith(
        actor,
        "example.test",
      );
      expect(dependencies.getSiteSectionForActor).toHaveBeenCalledWith(
        actor,
        "example.test",
        section,
      );
      expect(
        dependencies.writableSiteForActor.mock.invocationCallOrder[0],
      ).toBeLessThan(
        dependencies.getSiteSectionForActor.mock.invocationCallOrder[0],
      );
    },
  );

  it("does not read deployment keys for a read-only user", async () => {
    dependencies.writableSiteForActor.mockRejectedValue(
      new AppError("FORBIDDEN", "Website-write access is required.", 403),
    );

    const response = await get("users");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Website-write access is required.",
      },
    });
    expect(dependencies.getSiteSectionForActor).not.toHaveBeenCalled();
  });

  it("does not expose other website sections", async () => {
    const response = await get("env");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "That website section is not available from this endpoint.",
      },
    });
    expect(dependencies.writableSiteForActor).not.toHaveBeenCalled();
    expect(dependencies.getSiteSectionForActor).not.toHaveBeenCalled();
  });

  it("returns the standard failure envelope", async () => {
    dependencies.getSiteSectionForActor.mockRejectedValue(
      new AppError("CLOUDPANEL_UNAVAILABLE", "CloudPanel is unavailable.", 502),
    );

    const response = await get("git");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "CLOUDPANEL_UNAVAILABLE",
        message: "CloudPanel is unavailable.",
      },
    });
  });
});
