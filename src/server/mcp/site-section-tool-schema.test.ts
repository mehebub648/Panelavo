import { describe, expect, it } from "vitest";
import { operationCommands, operationFixCommands } from "@/schemas/operations";
import { siteSectionToolSchema } from "./site-section-tool-schema";

const domain = "site-100.example.com";

function parses(section: string, operation: Record<string, unknown>) {
  const result = siteSectionToolSchema.safeParse({
    domain,
    section,
    operation,
  });
  expect(
    result.success,
    result.success
      ? `${section}: ${String(operation.action)}`
      : `${section}: ${String(operation.action)}: ${JSON.stringify(result.error.issues)}`,
  ).toBe(true);
}

function rejects(section: string, operation: Record<string, unknown>) {
  expect(
    siteSectionToolSchema.safeParse({ domain, section, operation }).success,
    `${section}: ${String(operation.action)}`,
  ).toBe(false);
}

describe("MCP site-section tool schema", () => {
  it("publishes a correlated JSON schema for MCP clients", () => {
    const jsonSchema = siteSectionToolSchema["~standard"].jsonSchema.input({
      target: "draft-07",
    });
    const serialized = JSON.stringify(jsonSchema);

    expect(serialized).toContain('"const":"vhost"');
    expect(serialized).toContain('"const":"databases"');
    expect(serialized).toContain('"const":"save"');
    expect(serialized).toContain('"const":"add"');
    expect(serialized).not.toContain("manage-login");
  });

  it("accepts every allow-listed website-area action", () => {
    const operations: Record<string, Record<string, unknown>[]> = {
      vhost: [{ action: "save", content: "server { listen 443 ssl; }" }],
      databases: [
        {
          action: "add",
          name: "app-db",
          username: "app-user",
          password: "LongPassword!123",
        },
        { action: "delete", name: "app-db" },
      ],
      certificates: [
        {
          action: "lets-encrypt",
          subjectAlternativeName: "www.example.com, api.example.com",
        },
        { action: "set-default", id: "12" },
      ],
      security: [
        { action: "add-ip", value: "203.0.113.4" },
        { action: "delete-ip", value: "203.0.113.4" },
        { action: "add-bot", value: "BadBot" },
        { action: "delete-bot", value: "BadBot" },
        {
          action: "basic-auth",
          active: true,
          username: "visitor",
          password: "password",
        },
        { action: "cloudflare", enabled: true },
      ],
      users: [
        { action: "generate-keypair" },
        {
          action: "add-ssh",
          username: "deploy_user",
          password: "LongPassword!123",
          sshKeys: "ssh-ed25519 AAAA example",
        },
        { action: "delete-ssh", username: "deploy_user" },
        {
          action: "add-ftp",
          username: "files_user",
          password: "LongPassword!123",
          homeDirectory: "/home/site-user/htdocs",
        },
        { action: "delete-ftp", username: "files_user" },
      ],
      "file-manager": [
        { action: "list", path: "htdocs/app" },
        { action: "read", path: "htdocs/app/package.json" },
        {
          action: "read",
          path: "htdocs/app/image.png",
          encoding: "base64",
        },
        {
          action: "paste",
          path: "htdocs/app/copies",
          source: "htdocs/app/source.txt",
          mode: "copy",
        },
        { action: "new-file", path: "htdocs/app", name: "notes.txt" },
        { action: "new-folder", path: "htdocs/app", name: "storage" },
        {
          action: "upload",
          path: "htdocs/app",
          name: "small.txt",
          content: "aGVsbG8=",
        },
        {
          action: "save-file",
          path: "htdocs/app",
          name: "notes.txt",
          content: "hello",
        },
        {
          action: "rename",
          path: "htdocs/app",
          name: "old.txt",
          newName: "new.txt",
        },
        { action: "duplicate", path: "htdocs/app", name: "notes.txt" },
        {
          action: "chmod",
          path: "htdocs/app",
          name: "script.sh",
          mode: "0750",
        },
        {
          action: "compress",
          path: "htdocs/app",
          name: "storage",
          archiveName: "storage.zip",
        },
        {
          action: "extract",
          path: "htdocs/app",
          name: "storage.zip",
          extractTo: "htdocs/app/restored",
        },
        { action: "delete", path: "htdocs/app", name: "notes.txt" },
      ],
      git: [
        {
          action: "clone",
          url: "https://github.com/example/app.git",
          branch: "main",
        },
        { action: "init" },
        {
          action: "set-remote",
          url: "git@github.com:example/app.git",
        },
        { action: "fetch" },
        { action: "pull", branch: "main" },
        { action: "push", branch: "main" },
        { action: "checkout", branch: "release/v1" },
        { action: "commit", message: "Deploy release" },
        { action: "diff", path: "src/index.ts" },
        { action: "discard", path: "src/index.ts" },
        { action: "discard-all" },
      ],
      env: [
        {
          action: "save",
          file: ".env.production",
          entries: [{ key: "APP_ENV", value: "production" }],
          syncProfile: false,
        },
        {
          action: "upsert",
          entries: [{ key: "APP_URL", value: "https://example.com" }],
        },
      ],
      terminal: [{ action: "exec", command: "npm test", cwd: "app" }],
      backups: [
        {
          action: "create",
          files: true,
          databases: ["app_db"],
          note: "Before deployment",
        },
        { action: "restore", id: "backup-123", scope: "files" },
        { action: "delete", id: "backup-123" },
      ],
      "cron-jobs": [
        {
          action: "add",
          schedule: "*/5 * * * *",
          command: "php artisan schedule:run",
        },
        { action: "delete", id: 12 },
      ],
      logs: [
        { action: "read", name: "nginx/access.log" },
        { action: "clear", name: "nginx/error.log" },
      ],
    };

    Object.entries(operations).forEach(([section, inputs]) =>
      inputs.forEach((operation) => parses(section, operation)),
    );
  });

  it("accepts every server-owned operation and repair identifier", () => {
    for (const command of operationCommands) {
      const operation: Record<string, unknown> = { action: "run", command };
      if (["node-run", "npm-run"].includes(command)) operation.script = "build";
      if (
        [
          "pm2-restart-one",
          "pm2-stop-one",
          "pm2-delete-one",
          "prepare-rootless-migration",
        ].includes(command)
      )
        operation.name = "web";
      parses("actions", operation);
    }
    operationFixCommands.forEach((fix) =>
      parses("actions", { action: "fix", fix }),
    );
    ["compose", "node", "static-build", "php", "python"].forEach((plan) =>
      parses("actions", { action: "deploy", plan }),
    );
  });

  it("correlates sections with their operation and rejects UI-only sign-on", () => {
    rejects("vhost", { action: "commit", message: "wrong area" });
    rejects("git", { action: "save", content: "wrong area" });
    rejects("databases", { action: "manage-login", name: "app-db" });
    rejects("domains", { action: "sync", aliases: [] });
    rejects("settings", { action: "save" });
    rejects("unknown", { action: "read" });
  });

  it("rejects unknown fields and oversized ordinary operations while allowing file uploads", () => {
    rejects("logs", { action: "read", name: "app.log", extra: true });
    rejects("vhost", {
      action: "save",
      content: "x".repeat(128 * 1024),
    });
    parses("file-manager", {
      action: "upload",
      path: "htdocs/app",
      name: "large.txt",
      content: "A".repeat(128 * 1024),
    });
  });

  it("enforces database, certificate, and access-user boundaries", () => {
    rejects("databases", {
      action: "add",
      name: "1invalid",
      username: "app-user",
      password: "LongPassword!123",
    });
    rejects("databases", {
      action: "add",
      name: "app-db",
      username: "app-user",
      password: "too-short",
    });
    parses("certificates", {
      action: "lets-encrypt",
      subjectAlternativeName: Array.from(
        { length: 20 },
        (_, index) => `a${index}.example.com`,
      ).join(","),
    });
    rejects("certificates", {
      action: "lets-encrypt",
      subjectAlternativeName: Array.from(
        { length: 21 },
        (_, index) => `a${index}.example.com`,
      ).join(","),
    });
    rejects("users", {
      action: "add-ftp",
      username: "files_user",
      password: "LongPassword!123",
      homeDirectory: "/etc",
    });
  });

  it("enforces file containment, archive, and permission shapes", () => {
    rejects("file-manager", { action: "list", path: "htdocs/../etc" });
    rejects("file-manager", {
      action: "new-file",
      path: "htdocs/app",
      name: "nested/file.txt",
    });
    rejects("file-manager", {
      action: "chmod",
      path: "htdocs/app",
      name: "file.txt",
      mode: "999",
    });
    parses("file-manager", {
      action: "compress",
      path: "htdocs/app",
      name: "storage",
      archiveName: "storage.tar.gz",
    });
    rejects("file-manager", {
      action: "extract",
      path: "htdocs/app",
      name: "storage.tar",
      extractTo: "htdocs/app",
    });
  });

  it("retains existing conditional operation and per-area limits", () => {
    rejects("actions", { action: "run", command: "npm-run" });
    rejects("actions", {
      action: "run",
      command: "npm-install",
      script: "build",
    });
    rejects("actions", { action: "run", command: "pm2-restart-one" });
    rejects("git", { action: "commit", message: "x".repeat(501) });
    rejects("env", {
      action: "save",
      file: ".env",
      entries: Array.from({ length: 201 }, (_, index) => ({
        key: `KEY_${index}`,
        value: "value",
      })),
    });
    rejects("terminal", { action: "exec", command: "x".repeat(4001) });
    rejects("backups", {
      action: "create",
      databases: Array.from({ length: 51 }, (_, index) => `db_${index}`),
    });
    rejects("cron-jobs", {
      action: "add",
      schedule: "* * * *",
      command: "echo wrong schedule",
    });
    rejects("cron-jobs", {
      action: "add",
      schedule: "* * * * *",
      command: Array.from({ length: 21 }, (_, index) => `echo ${index}`).join(
        "\n",
      ),
    });
  });
});
