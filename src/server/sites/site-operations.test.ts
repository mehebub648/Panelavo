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
      { typeOverride: "docker" },
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
        .some((action) => action.id === "node-install"),
    ).toBe(false);
  });

  it("marks a validated, site-contained Compose deployment ready only for a Super Admin", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        permissions: { manage: true, docker: true },
        hasCompose: true,
        compose: {
          file: "docker-compose.yml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          configValid: true,
          safe: true,
          services: ["web", "worker"],
        },
      },
      { typeOverride: "docker" },
    );

    expect(data.preflight.status).toBe("ready");
    expect(data.plan).toMatchObject({
      id: "compose",
      status: "ready",
      scope: "host-root",
    });
    expect(data.plan?.steps.map((step) => step.command)).toEqual([
      "compose-validate",
      "compose-deploy",
      "compose-ps",
    ]);
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
      { typeOverride: "docker" },
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
    // The daemon cannot be started before the engine exists.
    expect(
      data.preflight.checks.find((item) => item.id === "docker-daemon")?.fix,
    ).toBeUndefined();
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
      id: "start-docker",
      status: "unauthorized",
    });
    expect(daemon?.fix?.blockedBy[0]).toContain("Super Admin");
  });

  it("attaches a Composer installer fix on PHP sites missing Composer", () => {
    const data = normalizeOperationsData({
      ...base,
      type: "php",
      permissions: { manage: true, docker: true },
      hasComposer: true,
      tools: {
        ...base.tools,
        composer: { id: "composer", label: "Composer", available: false },
      },
    });

    expect(
      data.preflight.checks.find((item) => item.id === "composer")?.fix,
    ).toMatchObject({ id: "install-composer", status: "ready" });
    // Ready checks never carry a fix.
    expect(
      data.preflight.checks.find((item) => item.id === "php-runtime")?.fix,
    ).toBeUndefined();
  });

  it("offers a site-scoped port-binding fix on a port-only safety failure", () => {
    const data = normalizeOperationsData(
      {
        ...base,
        // A site manager (manage) who is not a Super Admin (docker: false)
        // can still edit the site's own Compose file.
        permissions: { manage: true, docker: false },
        hasCompose: true,
        compose: {
          file: "compose.yaml",
          cliAvailable: true,
          pluginAvailable: true,
          daemonAvailable: true,
          configValid: true,
          safe: false,
          portFixable: true,
          detail: 'Service "backend" publishes a port without binding it to 127.0.0.1.',
          services: ["backend"],
        },
      },
      { typeOverride: "docker" },
    );

    const safety = data.preflight.checks.find(
      (item) => item.id === "compose-safety",
    );
    expect(safety?.status).toBe("blocked");
    expect(safety?.fix).toMatchObject({
      id: "bind-ports-loopback",
      scope: "site-user",
      status: "ready",
    });
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
          portFixable: false,
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
