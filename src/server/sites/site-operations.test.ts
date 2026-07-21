import { describe, expect, it } from "vitest";
import type { RawOperationsData } from "@/types/operations";
import { normalizeOperationsData } from "./site-operations";

const base: RawOperationsData = {
  type: "nodejs",
  path: "/home/site/htdocs/app.example.com",
  checkedAt: "2026-07-12T00:00:00.000Z",
  permissions: { manage: true, docker: false },
  tools: {
    node: { id: "node", label: "Node.js", available: true },
    npm: { id: "npm", label: "npm", available: true },
    pm2: { id: "pm2", label: "PM2", available: true },
    php: { id: "php", label: "PHP", available: true },
    composer: { id: "composer", label: "Composer", available: true },
    python: { id: "python", label: "Python", available: true },
    curl: { id: "curl", label: "curl", available: true },
  },
};

const rootlessReady = {
  mode: "rootless" as const,
  ready: true,
  uidmapAvailable: true,
  rootlessExtrasAvailable: true,
  buildxAvailable: true,
  buildxHostReady: true,
  hostRootlessReady: true,
  networkHelperAvailable: true,
  subuidReady: true,
  subgidReady: true,
  lingerEnabled: true,
  runtimeDirectoryReady: true,
  userBusReady: true,
  socketReady: true,
  daemonAvailable: true,
  securityRootless: true,
  storageReady: true,
  cgroupReady: true,
  storageDriver: "overlay2",
};

describe("normalizeOperationsData", () => {
  it("keeps a detected Compose project visible but blocks deployment when Docker is missing", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        type: "reverse-proxy",
        permissions: { manage: true, docker: true },
        hasCompose: true,
        hasPackageJson: true,
        packageManager: { id: "npm", label: "npm", available: true },
        framework: "Docker Compose",
        compose: {
          file: "compose.yaml",
          cliAvailable: false,
          pluginAvailable: false,
          daemonAvailable: false,
        },
      },
      { typeOverride: "docker", panelAdmin: true },
    );

    expect(data.architecture.primary.id).toBe("compose");
    expect(data.preflight.status).toBe("blocked");
    expect(
      data.preflight.checks.find((item) => item.id === "docker-cli"),
    ).toMatchObject({
      status: "blocked",
      blocker: true,
    });
    expect(data.plan).toMatchObject({ id: "compose", status: "blocked" });
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .some((action) => action.id === "compose-up"),
    ).toBe(true);
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "compose-up"),
    ).toMatchObject({ status: "blocked" });
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "compose-deploy"),
    ).toMatchObject({ status: "blocked" });
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .some((action) => action.id === "node-install"),
    ).toBe(false);
  });

  it("allows a site-write user to manage a healthy private rootless project", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: false },
        hasCompose: true,
        compose: {
          file: "docker-compose.yml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          rootless: rootlessReady,
          configValid: true,
          safe: true,
          services: ["web", "worker"],
          expectedPort: 24001,
          entryService: "web",
          containerPort: 3000,
          publishedPort: 24001,
          portMatches: true,
          canAutoRemap: false,
          portDetail:
            'Entry service "web" maps container port 3000 to 127.0.0.1:24001, matching CloudPanel.',
        },
      },
      { typeOverride: "docker" },
    );

    expect(data.preflight.status).toBe("ready");
    expect(data.plan).toMatchObject({
      id: "compose",
      status: "ready",
      scope: "site-user",
    });
    expect(data.plan?.steps.map((step) => step.command)).toEqual([
      "compose-validate",
      "compose-deploy",
      "compose-ps",
      "compose-port-verify",
    ]);
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "compose-deploy"),
    ).toMatchObject({
      label: "Build & start services",
      commandPreview: "docker compose up -d --build --remove-orphans",
      status: "ready",
    });
  });

  it("keeps migration preparation and cutover Super Admin-only", () => {
    const raw: RawOperationsData = {
      ...base,
      permissions: { manage: true, docker: false },
      hasCompose: true,
      compose: {
        file: "compose.yaml",
        cliAvailable: true,
        pluginAvailable: true,
        daemonAvailable: true,
        rootless: rootlessReady,
        configValid: true,
        safe: true,
        services: ["web", "worker"],
      },
      migration: {
        legacyRootfulDetected: true,
        preparedServices: ["web"],
        allServicesPrepared: false,
      },
    };
    const regularAdmin = normalizeOperationsData(raw, {
      typeOverride: "docker",
    });
    expect(
      regularAdmin.groups
        .flatMap((group) => group.actions)
        .find(
          (action) =>
            action.id === "prepare-rootless-migration" &&
            action.input?.name === "worker",
        ),
    ).toMatchObject({ status: "unauthorized", scope: "host-root" });

    const superAdmin = normalizeOperationsData(
      {
        ...raw,
        migration: { ...raw.migration, allServicesPrepared: true },
      },
      { typeOverride: "docker", panelAdmin: true },
    );
    expect(
      superAdmin.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "cutover-rootless-migration"),
    ).toMatchObject({ status: "ready", scope: "host-root" });
  });

  it("keeps host-safety review pending when Compose validation fails", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          rootless: rootlessReady,
          configValid: false,
          detail: "HEALTHCHECK_RETRIES is not set: invalid syntax",
        },
      },
      { typeOverride: "docker", panelAdmin: true },
    );

    expect(
      data.preflight.checks.find((item) => item.id === "compose-config"),
    ).toMatchObject({
      status: "blocked",
      blocker: true,
      detail: "HEALTHCHECK_RETRIES is not set: invalid syntax",
    });
    expect(
      data.preflight.checks.find((item) => item.id === "compose-safety"),
    ).toMatchObject({
      status: "warning",
      blocker: false,
      detail:
        "Host-safety checks will run after the Compose configuration can be resolved.",
    });
  });

  it("explains missing Compose environment values without exposing Docker logs", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          configValid: false,
          detail:
            'time="2026-07-12T05:30:18Z" level=warning msg="The \\"HOST_DATA_DIR\\" variable is not set. Defaulting to a blank string." time="2026-07-12T05:30:18Z" level=warning msg="The \\"BACKEND_DATA_DIR\\" variable is not set. Defaulting to a blank string."',
        },
      },
      { typeOverride: "docker", panelAdmin: true },
    );

    const validation = data.preflight.checks.find(
      (item) => item.id === "compose-config",
    );
    expect(validation?.detail).toBe(
      "Compose cannot validate because 2 environment variables are missing: `HOST_DATA_DIR`, `BACKEND_DATA_DIR`.",
    );
    expect(validation?.detail).not.toContain("level=warning");
    expect(validation?.remediation).toContain("website's Environment section");
  });

  it("keeps deployment ready while planning an unambiguous Compose entry-port remap", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          rootless: rootlessReady,
          configValid: true,
          safe: true,
          services: ["backend", "frontend"],
          expectedPort: 24001,
          entryService: "frontend",
          containerPort: 3000,
          publishedPort: 3000,
          portMatches: false,
          canAutoRemap: true,
          portDetail:
            'Entry service "frontend" currently uses host port 3000; deployment will map container port 3000 to 127.0.0.1:24001 for CloudPanel.',
          additionalPorts: [
            {
              service: "backend",
              containerPort: 4000,
              publishedPort: 4000,
              hostIp: "127.0.0.1",
            },
          ],
        },
      },
      { typeOverride: "docker", panelAdmin: true },
    );

    expect(data.preflight.status).toBe("warning");
    expect(
      data.preflight.checks.find((item) => item.id === "entry-port"),
    ).toMatchObject({ status: "warning", blocker: false });
    expect(data.plan).toMatchObject({ id: "compose", status: "ready" });
    expect(data.plan?.warnings.join(" ")).toContain("127.0.0.1:24001");
  });

  it("uses the detected Node package manager and includes deterministic build and PM2 steps", () => {
    const data = normalizeOperationsData({
      ...base,
      hasPackageJson: true,
      hasPackageLock: true,
      hasBuildScript: true,
      hasStartScript: true,
      packageManager: {
        id: "pnpm",
        label: "pnpm",
        available: true,
        lockfile: "pnpm-lock.yaml",
      },
      scripts: [
        { name: "build", command: "next build" },
        { name: "start", command: "next start" },
      ],
    });

    expect(data.preflight.status).toBe("ready");
    expect(data.plan?.id).toBe("node");
    expect(data.plan?.steps.map((step) => step.command)).toEqual([
      "node-install",
      "node-run:build",
      "pm2-start",
      "pm2-save",
    ]);
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "node-install")?.label,
    ).toContain("pnpm");
  });

  it("warns about a Node port mismatch and verifies the configured port after deployment", () => {
    const data = normalizeOperationsData({
      ...base,
      expectedPort: 24001,
      port: {
        expected: 24001,
        listening: false,
        detected: [3000],
        detail:
          "CloudPanel expects port 24001, but site-owned processes currently listen on 3000.",
      },
      hasPackageJson: true,
      hasStartScript: true,
      packageManager: {
        id: "npm",
        label: "npm",
        available: true,
        lockfile: "package-lock.json",
      },
    });

    expect(
      data.preflight.checks.find((item) => item.id === "runtime-port"),
    ).toMatchObject({ status: "warning", blocker: false });
    expect(data.plan).toMatchObject({ id: "node", status: "ready" });
    expect(data.plan?.steps.at(-1)?.command).toBe("runtime-port-verify");
    expect(data.plan?.warnings.join(" ")).toContain("listen on 3000");
  });

  it("blocks a reverse-proxy site when its configured local upstream is not listening", () => {
    const data = normalizeOperationsData({
      ...base,
      type: "reverse-proxy",
      reverseProxyUrl: "http://127.0.0.1:24001",
      expectedPort: 24001,
      port: {
        expected: 24001,
        listening: false,
        detected: [3000],
        detail:
          "CloudPanel expects port 24001, but site-owned processes currently listen on 3000.",
      },
    });

    expect(
      data.preflight.checks.find((item) => item.id === "upstream-port"),
    ).toMatchObject({ status: "blocked", blocker: true });
    expect(data.preflight.status).toBe("blocked");
  });

  it("blocks an ambiguous Node lockfile selection instead of guessing", () => {
    const data = normalizeOperationsData({
      ...base,
      hasPackageJson: true,
      hasStartScript: true,
      packageManager: {
        id: "unknown",
        label: "Package manager",
        available: false,
        ambiguous: true,
        detail: "Multiple lockfiles disagree.",
      },
    });

    expect(data.preflight.status).toBe("blocked");
    expect(data.plan?.blockedBy).toContain("Multiple lockfiles disagree.");
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "node-install"),
    ).toMatchObject({ status: "blocked" });
  });

  it("builds a Laravel plus frontend plan without automatically running migrations", () => {
    const data = normalizeOperationsData({
      ...base,
      type: "php",
      hasComposer: true,
      hasComposerLock: true,
      hasArtisan: true,
      hasEnvFile: true,
      hasPackageJson: true,
      hasBuildScript: true,
      packageManager: {
        id: "npm",
        label: "npm",
        available: true,
        lockfile: "package-lock.json",
      },
      scripts: [{ name: "build", command: "vite build" }],
    });

    expect(data.plan?.steps.map((step) => step.command)).toEqual([
      "node-install",
      "node-run:build",
      "composer-install-production",
      "artisan-optimize",
    ]);
    expect(
      data.plan?.steps.some((step) => step.command.includes("migrate")),
    ).toBe(false);
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .find((action) => action.id === "artisan-migrate"),
    ).toMatchObject({ risk: "destructive" });
  });

  it("offers Super Admins a click-to-fix for missing host software", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        type: "reverse-proxy",
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: false,
          pluginAvailable: false,
          daemonAvailable: false,
        },
      },
      { typeOverride: "docker", panelAdmin: true },
    );

    const cli = data.preflight.checks.find((item) => item.id === "docker-cli");
    expect(cli?.fix).toMatchObject({
      id: "install-docker",
      status: "ready",
      scope: "host-root",
    });
    // Without the CLI, the plugin check routes to the full engine install.
    expect(
      data.preflight.checks.find((item) => item.id === "compose-plugin")?.fix,
    ).toMatchObject({ id: "install-docker" });
    expect(
      data.preflight.checks.find((item) => item.id === "docker-daemon")?.fix,
    ).toMatchObject({ id: "initialize-rootless-docker", status: "ready" });
  });

  it("blocks fixes for admins who are not Super Admins", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        type: "reverse-proxy",
        permissions: { manage: true, docker: false },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: false,
        },
      },
      { typeOverride: "docker" },
    );

    const daemon = data.preflight.checks.find(
      (item) => item.id === "docker-daemon",
    );
    expect(daemon?.fix).toMatchObject({
      id: "initialize-rootless-docker",
      status: "unauthorized",
    });
    expect(daemon?.fix?.blockedBy[0]).toContain("Super Admin");
  });

  it("lets a site-write user self-init the runtime once the host is provisioned", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        type: "reverse-proxy",
        // Site-write, but NOT a Super Admin (no panelAdmin, no docker).
        permissions: { manage: true, docker: false },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: false,
          rootless: {
            mode: "rootless",
            hostRootlessReady: true,
            uidmapAvailable: true,
            rootlessExtrasAvailable: true,
            buildxHostReady: true,
            networkHelperAvailable: true,
            subuidReady: true,
            subgidReady: true,
            lingerEnabled: false,
            runtimeDirectoryReady: false,
            userBusReady: false,
            daemonAvailable: false,
          },
        },
      },
      { typeOverride: "docker" },
    );

    // Host prerequisites are provisioned, so that check is green.
    expect(
      data.preflight.checks.find((item) => item.id === "rootless-prerequisites"),
    ).toMatchObject({ status: "ready" });
    // The per-user daemon is down, and a site-write user can start it
    // themselves — the fix is the site-scoped runtime self-init, authorized.
    const daemon = data.preflight.checks.find(
      (item) => item.id === "docker-daemon",
    );
    expect(daemon?.fix).toMatchObject({
      id: "initialize-rootless-runtime",
      scope: "site",
      status: "ready",
    });
    expect(daemon?.fix?.blockedBy).toEqual([]);
  });

  it("attaches a Composer installer fix on PHP sites missing Composer", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        type: "php",
        permissions: { manage: true, docker: true },
        hasComposer: true,
        tools: {
          ...base.tools,
          composer: { id: "composer", label: "Composer", available: false },
        },
      },
      { panelAdmin: true },
    );

    expect(
      data.preflight.checks.find((item) => item.id === "composer")?.fix,
    ).toMatchObject({ id: "install-composer", status: "ready" });
    // Ready checks never carry a fix.
    expect(
      data.preflight.checks.find((item) => item.id === "php-runtime")?.fix,
    ).toBeUndefined();
  });

  it("does not offer the port fix when a non-port feature also fails safety", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          configValid: true,
          safe: false,
          detail: 'Service "backend" requests privileged mode.',
        },
      },
      { typeOverride: "docker" },
    );

    expect(
      data.preflight.checks.find((item) => item.id === "compose-safety")?.fix,
    ).toBeUndefined();
  });

  it("keeps assigned read-only users from running otherwise detected actions", () => {
    const data = normalizeOperationsData({
      ...base,
      permissions: { manage: false, docker: false },
      hasPackageJson: true,
      hasStartScript: true,
      packageManager: { id: "npm", label: "npm", available: true },
    });

    expect(data.preflight.status).toBe("unauthorized");
    expect(data.plan?.status).toBe("unauthorized");
    expect(
      data.groups
        .flatMap((group) => group.actions)
        .every((action) => action.status === "unauthorized"),
    ).toBe(true);
  });
});
