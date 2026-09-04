import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateFleetKeyPair } from "./crypto";
import { FLEET_CAPABILITIES } from "./types";
import { mutateFleetState } from "./store";
import {
  acceptFleetEnrollment,
  createFleetInvitation,
  enableFleetHub,
  fleetCapabilityForAction,
} from "./service";

describe("Fleet enrollment and capabilities", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-fleet-service-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.SESSION_SECRET =
      "fleet-test-session-secret-at-least-32-characters";
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(directory, { recursive: true, force: true });
  });

  it("consumes a ten-minute invitation once", async () => {
    await enableFleetHub("Fleet", "https://hub.example.com");
    const created = await createFleetInvitation({
      id: "owner",
      username: "owner",
    });
    expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
    const keys = generateFleetKeyPair();
    const request = {
      invitation: created.invitation,
      descriptor: {
        nodeId: "6ca72a44-ae2e-450c-a897-7675e6dcc659",
        label: "Node",
        origin: "https://node.example.com",
        panelVersion: "0.1.115",
        brokerProtocolVersion: 24,
        fleetProtocolVersion: 1,
        capabilities: [...FLEET_CAPABILITIES],
        publicKey: keys.publicKey,
      },
      owner: { id: "node-owner", username: "node-owner" },
    };
    await expect(acceptFleetEnrollment(request)).resolves.toMatchObject({
      hubOrigin: "https://hub.example.com",
    });
    await expect(
      acceptFleetEnrollment({
        ...request,
        descriptor: {
          ...request.descriptor,
          nodeId: "4b850408-00b4-45b0-a324-a812718660bd",
          origin: "https://node2.example.com",
        },
      }),
    ).rejects.toThrow(/expired|already used/i);
    const expired = await createFleetInvitation({
      id: "owner",
      username: "owner",
    });
    await mutateFleetState((state) => {
      for (const invitation of state.invitations)
        invitation.expiresAt = new Date(0).toISOString();
    });
    await expect(
      acceptFleetEnrollment({
        ...request,
        invitation: expired.invitation,
        descriptor: {
          ...request.descriptor,
          nodeId: "2f25bf46-e83c-42e9-af2f-e482c08d028f",
          origin: "https://node3.example.com",
        },
      }),
    ).rejects.toThrow(/expired|already used/i);
  });

  it("maps remote actions to finite advertised capabilities", () => {
    expect(fleetCapabilityForAction("system.summary")).toBe("system.read");
    expect(fleetCapabilityForAction("sites.create")).toBe("sites.write");
    expect(fleetCapabilityForAction("site.section.get")).toBe(
      "site-sections.read",
    );
    expect(fleetCapabilityForAction("vpn.manage")).toBe("vpn.write");
  });
});
