import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import type { FleetSignedEnvelope } from "./types";
import {
  acceptFleetEnrollment,
  completeFleetHandshake,
  connectToFleetHub,
  createFleetInvitation,
  dispatchFleetAction,
  disconnectNodeFromHub,
  enableFleetHub,
  executeFederationRequest,
  renameConnectedServer,
  revokeFederationRequest,
  revokeFleetAuthorizationForUser,
} from "./service";
import { getFleetState, mutateFleetState } from "./store";
import {
  answerAddressProof,
  changePanelAddress,
  handleAddressEnvelope,
} from "./address";
import { getPanelAddressState } from "@/server/settings/panel-address-store";

const mock = vi.hoisted(() => ({
  transport: vi.fn(),
  currentUser: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./network", async (original) => ({
  ...(await original<typeof import("./network")>()),
  postFleetJson: mock.transport,
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    getServerInfo: async () => ({ hostname: "Test server" }),
    getCurrentUser: mock.currentUser,
  }),
}));
vi.mock("@/server/auth/panel-roles", () => ({
  decorateUser: async (user: unknown) => user,
}));
vi.mock("./actions", () => ({ executeFleetAction: mock.execute }));
vi.mock("@/server/security/log", () => ({
  audit: vi.fn(),
  auditContext: (value: unknown) => value,
}));

describe("independent many-to-many server connections", () => {
  let directory: string;
  let active = "";
  const user = (name: string) => ({
    id: name,
    username: name,
    panelRole: "super-admin" as const,
    status: true,
  });
  const actor = (name: string) =>
    ({
      user: user(name),
      authentication: "session",
      cloudPanel: { usernameHint: name, cliAuthenticated: true, cookies: {} },
    }) as PanelActor;
  async function at<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = active;
    active = name;
    process.env.PANEL_DATA_DIR = join(directory, name);
    try {
      return await work();
    } finally {
      active = previous;
      process.env.PANEL_DATA_DIR = join(directory, previous);
    }
  }
  async function connect(manager: string, target: string) {
    const token = await at(manager, async () => {
      await enableFleetHub(manager, `https://${manager}.example.com`);
      return createFleetInvitation(user(manager));
    });
    await at(target, () =>
      connectToFleetHub(
        actor(target),
        token.invitation,
        `https://${target}.example.com`,
      ),
    );
    return at(
      manager,
      async () =>
        (await getFleetState()).nodes.find(
          (node) => node.node.origin === `https://${target}.example.com`,
        )!.id,
    );
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-multi-"));
    process.env.SESSION_SECRET =
      "test-only-server-connections-secret-32-characters";
    mock.currentUser.mockImplementation(async () => user(active));
    mock.execute.mockImplementation(async (who: PanelActor) => ({
      owner: who.user.id,
      resources: {
        cpu: { usedPercent: 1 },
        memory: { usedPercent: 1 },
        disk: { usedPercent: 1 },
      },
    }));
    mock.transport.mockImplementation(
      async (origin: string, path: string, payload: unknown) =>
        at(
          new URL(origin).hostname.split(".")[0].replace(/^moved-/, ""),
          async () => {
            if (path.endsWith("/address-proof"))
              return {
                success: true,
                data: answerAddressProof(
                  (payload as { challenge: string }).challenge,
                ),
              };
            if (path.endsWith("/address"))
              return handleAddressEnvelope(payload as FleetSignedEnvelope);
            if (path.endsWith("/enroll"))
              return {
                success: true,
                data: await acceptFleetEnrollment(payload),
              };
            if (path.endsWith("/handshake"))
              return completeFleetHandshake(payload as FleetSignedEnvelope);
            if (path.endsWith("/execute"))
              return executeFederationRequest(payload as FleetSignedEnvelope);
            if (path.endsWith("/revoke"))
              return revokeFederationRequest(payload as FleetSignedEnvelope);
            throw new Error("Unexpected peer endpoint");
          },
        ),
    );
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    vi.clearAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("allows full-scope panel controls but rejects legacy links and revoked owners", async () => {
    const ab = await connect("a", "b");
    await expect(
      at("a", () =>
        dispatchFleetAction(ab, "panel.connections.list", {}, actor("a")),
      ),
    ).resolves.toMatchObject({ owner: "b" });
    await expect(
      at("a", () =>
        dispatchFleetAction(ab, "panel.address.get", {}, actor("a")),
      ),
    ).resolves.toMatchObject({ owner: "b" });
    await at("b", () =>
      mutateFleetState((state) => {
        state.nodeLinks[0].fullAdmin = false;
      }),
    );
    await expect(
      at("a", () =>
        dispatchFleetAction(ab, "panel.connections.manage", {}, actor("a")),
      ),
    ).rejects.toThrow(/full Super Admin/);
    await expect(
      at("a", () =>
        dispatchFleetAction(ab, "panel.address.change", {}, actor("a")),
      ),
    ).rejects.toThrow(/full Super Admin/);
    mock.currentUser.mockResolvedValue({ ...user("b"), status: false });
    await expect(
      at("a", () => dispatchFleetAction(ab, "sites.list", {}, actor("a"))),
    ).rejects.toThrow(/no longer active/);
  });

  it("supports A→B, C→B and B→A with isolated keys, nicknames and single-connection revocation", async () => {
    const ab = await connect("a", "b");
    const cb = await connect("c", "b");
    const ba = await connect("b", "a");
    const stateB = await at("b", getFleetState);
    expect(stateB.nodeLinks).toHaveLength(2);
    expect(stateB.nodes).toHaveLength(1);
    expect(stateB.nodeLinks[0].nodePrivateKey).not.toBe(
      stateB.nodeLinks[1].nodePrivateKey,
    );
    await expect(
      at("a", () => dispatchFleetAction(ab, "sites.list", {}, actor("a"))),
    ).resolves.toMatchObject({ owner: "b" });
    await expect(
      at("b", () => dispatchFleetAction(ba, "sites.list", {}, actor("b"))),
    ).resolves.toMatchObject({ owner: "a" });
    await at("a", () => renameConnectedServer(ab, "Production"));
    expect((await at("a", getFleetState)).nodes[0].nickname).toBe("Production");
    await at("b", () => disconnectNodeFromHub(actor("b"), ab));
    expect((await at("a", getFleetState)).nodes).toHaveLength(0);
    expect((await at("b", getFleetState)).nodeLinks).toHaveLength(1);
    await expect(
      at("c", () => dispatchFleetAction(cb, "sites.list", {}, actor("c"))),
    ).resolves.toMatchObject({ owner: "b" });
    await expect(
      at("b", () => dispatchFleetAction(ba, "sites.list", {}, actor("b"))),
    ).resolves.toMatchObject({ owner: "a" });
  });
  it("rejects remote actions immediately when the connection owner is demoted", async () => {
    const ab = await connect("a", "b");
    mock.currentUser.mockImplementation(async () => ({
      ...user(active),
      panelRole: "admin",
    }));
    await expect(
      at("a", () => dispatchFleetAction(ab, "sites.list", {}, actor("a"))),
    ).rejects.toThrow(/no longer active/);
  });
  it("revokes all incoming access owned by a changed account, not its outgoing connections", async () => {
    await connect("a", "b");
    await connect("c", "b");
    await connect("b", "a");
    await at("b", () => revokeFleetAuthorizationForUser(user("b")));
    const state = await at("b", getFleetState);
    expect(state.nodeLinks).toHaveLength(0);
    expect(state.nodes).toHaveLength(1);
  });
  it("preserves bidirectional identity and keys when either panel changes address", async () => {
    const ab = await connect("a", "b");
    const cb = await connect("c", "b");
    const ba = await connect("b", "a");
    const before = await at("b", getFleetState);
    await expect(
      at("b", () =>
        changePanelAddress(
          "https://moved-b.example.com",
          "https://b.example.com",
          actor("b"),
        ),
      ),
    ).resolves.toMatchObject({ pending: false });
    const after = await at("b", getFleetState);
    expect(after.localNodeId).toBe(before.localNodeId);
    expect(after.nodeLinks.map((link) => link.nodePrivateKey)).toEqual(
      before.nodeLinks.map((link) => link.nodePrivateKey),
    );
    expect(after.hub?.id).toBe(before.hub?.id);
    expect((await at("a", getFleetState)).nodes[0].node.origin).toBe(
      "https://moved-b.example.com",
    );
    expect((await at("a", getFleetState)).nodeLinks[0].hubOrigin).toBe(
      "https://moved-b.example.com",
    );
    await expect(
      at("a", () => dispatchFleetAction(ab, "sites.list", {}, actor("a"))),
    ).resolves.toMatchObject({ owner: "b" });
    await expect(
      at("c", () => dispatchFleetAction(cb, "sites.list", {}, actor("c"))),
    ).resolves.toMatchObject({ owner: "b" });
    await expect(
      at("a", () =>
        changePanelAddress(
          "https://moved-a.example.com",
          "https://a.example.com",
          actor("a"),
        ),
      ),
    ).resolves.toMatchObject({ pending: false });
    await expect(
      at("b", () => dispatchFleetAction(ba, "sites.list", {}, actor("b"))),
    ).resolves.toMatchObject({ owner: "a" });
    await at("a", () => enableFleetHub("a", "https://moved-a.example.com"));
    expect(
      (await at("a", createFleetInvitation.bind(null, user("a")))).invitation,
    ).toMatch(/^pnl_fleet_/);
  });
  it("keeps the old address active and resumes a persisted change after a peer outage", async () => {
    await connect("a", "b");
    const transport = mock.transport.getMockImplementation()!;
    mock.transport.mockImplementation((origin, path, payload) => {
      if (path.endsWith("/address")) throw new Error("offline");
      return transport(origin, path, payload);
    });
    await expect(
      at("b", () =>
        changePanelAddress(
          "https://moved-b.example.com",
          "https://b.example.com",
          actor("b"),
        ),
      ),
    ).resolves.toMatchObject({ pending: true, remaining: 1 });
    const pending = await at("b", async () => getPanelAddressState());
    expect(pending.origin).toBeUndefined();
    expect(pending.pending?.origin).toBe("https://moved-b.example.com");
    mock.transport.mockImplementation(transport);
    await expect(
      at("b", () =>
        changePanelAddress(
          "https://moved-b.example.com",
          "https://b.example.com",
          actor("b"),
        ),
      ),
    ).resolves.toMatchObject({ pending: false });
  });
  it("refuses a domain serving another panel before changing any connection", async () => {
    await connect("a", "b");
    await expect(
      at("b", () =>
        changePanelAddress(
          "https://c.example.com",
          "https://b.example.com",
          actor("b"),
        ),
      ),
    ).rejects.toThrow(/same panel/);
    expect((await at("a", getFleetState)).nodes[0].node.origin).toBe(
      "https://b.example.com",
    );
    expect(
      (await at("b", async () => getPanelAddressState())).pending,
    ).toBeUndefined();
    await expect(
      at("b", () =>
        changePanelAddress(
          "https://moved-b.example.com",
          "https://b.example.com",
          { ...actor("b"), authentication: "fleet" },
        ),
      ),
    ).rejects.toThrow(/authorized/);
  });
  it("rejects replayed and tampered address notifications", async () => {
    await connect("a", "b");
    const transport = mock.transport.getMockImplementation()!;
    let notification: FleetSignedEnvelope | undefined;
    mock.transport.mockImplementation((origin, path, payload) => {
      if (
        path.endsWith("/address") &&
        JSON.parse(
          Buffer.from(
            (payload as FleetSignedEnvelope).protected,
            "base64url",
          ).toString(),
        ).action === "fleet.address.update"
      )
        notification = payload as FleetSignedEnvelope;
      return transport(origin, path, payload);
    });
    await at("b", () =>
      changePanelAddress(
        "https://moved-b.example.com",
        "https://b.example.com",
        actor("b"),
      ),
    );
    expect(notification).toBeDefined();
    await expect(
      at("a", () => handleAddressEnvelope(notification!)),
    ).rejects.toThrow(/already used/);
    await expect(
      at("a", () =>
        handleAddressEnvelope({
          ...notification!,
          payload: Buffer.from(
            JSON.stringify({ origin: "https://attacker.example.com" }),
          ).toString("base64url"),
        }),
      ),
    ).rejects.toThrow(/signature/);
    expect((await at("a", getFleetState)).nodes[0].node.origin).toBe(
      "https://moved-b.example.com",
    );
  });
  it("does not forward another server's connections and rejects live account demotion", async () => {
    const ab = await connect("a", "b");
    const bc = await connect("b", "c");
    await expect(
      at("a", () => dispatchFleetAction(bc, "sites.list", {}, actor("a"))),
    ).rejects.toThrow(/not found/i);
    mock.currentUser.mockImplementation(async () => ({
      ...user(active),
      panelRole: "user",
    }));
    await expect(
      at("a", () => dispatchFleetAction(ab, "sites.list", {}, actor("a"))),
    ).rejects.toThrow(/no longer active/i);
    expect((await at("b", getFleetState)).nodeLinks[0].status).toBe(
      "suspended",
    );
  });
});
