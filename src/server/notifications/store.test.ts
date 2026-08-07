import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPublicNotificationSettings, saveNotificationSettings } from "./store";

describe("notification settings", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-notifications-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.CREDENTIALS_ENCRYPTION_KEY = "n".repeat(32);
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    await rm(directory, { recursive: true, force: true });
  });

  it("never returns the saved SMTP password", async () => {
    await saveNotificationSettings({
      smtp: { enabled: true, host: "smtp.example.com", port: 465, secure: true, username: "panel", password: "secret", from: "panel@example.com", to: "ops@example.com" },
      webhook: { enabled: false, url: "https://hooks.example.com/panel" },
    });
    expect(await getPublicNotificationSettings()).toMatchObject({
      smtp: { password: "", hasPassword: true },
    });
  });
});
