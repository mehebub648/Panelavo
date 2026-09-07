import { describe, expect, it } from "vitest";
import { requiresMcpConfirmation } from "./confirmation-policy";

describe("MCP confirmation policy", () => {
  it.each([
    "panelavo_execute_terminal_command",
    "panelavo_deploy_site",
    "panelavo_deploy_artifact_release",
  ])("does not add a second prompt to authorized site work: %s", (tool) => {
    expect(requiresMcpConfirmation(tool, { domain: "site.example" })).toBe(
      false,
    );
  });

  it.each(["list", "read", "upload", "save-file", "extract"])(
    "allows ordinary file-manager %s without elicitation",
    (action) => {
      expect(
        requiresMcpConfirmation("panelavo_manage_site_section", {
          section: "file-manager",
          operation: { action },
        }),
      ).toBe(false);
    },
  );

  it("applies the same policy to both terminal entry points", () => {
    expect(
      requiresMcpConfirmation("panelavo_manage_site_section", {
        section: "terminal",
        operation: { action: "exec", command: "pwd" },
      }),
    ).toBe(false);
  });

  it.each([
    ["panelavo_delete_site", {}],
    ["panelavo_restore_lancedb_snapshot", {}],
    ["panelavo_run_site_recovery", {}],
    [
      "panelavo_manage_site_section",
      { section: "backups", operation: { action: "restore" } },
    ],
    [
      "panelavo_manage_site_section",
      { section: "file-manager", operation: { action: "delete" } },
    ],
    [
      "panelavo_manage_site_section",
      { section: "file-manager", operation: { action: "paste", mode: "cut" } },
    ],
    [
      "panelavo_manage_site_section",
      { section: "vhost", operation: { action: "save" } },
    ],
    ["unknown", {}],
  ])(
    "retains confirmation for destructive or unknown actions: %s",
    (tool, args) => {
      expect(requiresMcpConfirmation(tool, args)).toBe(true);
    },
  );
});
