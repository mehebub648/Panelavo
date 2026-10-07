import { describe, expect, it } from "vitest";
import { buildPanelavoPluginZip } from "./package";

function storedFiles(archive: Buffer) {
  const files = new Map<string, string>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    files.set(
      archive.subarray(nameStart, dataStart - extraLength).toString("utf8"),
      archive.subarray(dataStart, dataStart + size).toString("utf8"),
    );
    offset = dataStart + size;
  }
  return files;
}

describe("downloadable Panelavo plugin", () => {
  it("packages one portable plugin with its hosted connection and guidance", async () => {
    const archive = await buildPanelavoPluginZip({
      origin: "https://selected.panel.example",
      resource: "https://selected.panel.example/connect/openai/mcp",
    });
    const files = storedFiles(archive);

    expect(Array.from(files.keys()).sort()).toEqual(
      [
        "panelavo-servers/assets/icon.svg",
        "panelavo-servers/mcp.json",
        "panelavo-servers/plugin.json",
        "panelavo-servers/skills/panelavo/SKILL.md",
      ].sort(),
    );
    expect(files.get("panelavo-servers/mcp.json")).toContain(
      "https://selected.panel.example/connect/openai/mcp",
    );
    expect(files.get("panelavo-servers/plugin.json")).toContain(
      "https://selected.panel.example/connect/privacy",
    );
    expect(files.get("panelavo-servers/skills/panelavo/SKILL.md")).toContain(
      "default application port matches the site id",
    );
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  });
});
