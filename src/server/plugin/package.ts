import { readFile } from "node:fs/promises";
import path from "node:path";

const packageFiles = [
  "plugin.json",
  "mcp.json",
  "assets/icon.svg",
  "skills/panelavo/SKILL.md",
] as const;

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name: string, data: Buffer, offset: number) {
  const fileName = Buffer.from(`panelavo-servers/${name}`, "utf8");
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(offset, 42);

  return {
    local: Buffer.concat([local, fileName, data]),
    central: Buffer.concat([central, fileName]),
  };
}

export async function buildPanelavoPluginZip(connection: {
  origin: string;
  resource: string;
}) {
  const source = path.join(process.cwd(), "plugins", "panelavo");
  const files = await Promise.all(
    packageFiles.map(async (name) => {
      let data = await readFile(path.join(source, ...name.split("/")));
      if (name === "mcp.json") {
        const config = JSON.parse(data.toString("utf8")) as {
          mcpServers: { panelavo: { url: string } };
        };
        config.mcpServers.panelavo.url = connection.resource;
        data = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
      } else if (name === "plugin.json") {
        const manifest = JSON.parse(data.toString("utf8")) as {
          homepage: string;
          extensions: {
            "com.openai": {
              interface: Record<string, unknown>;
            };
          };
        };
        const base = `${connection.origin}/connect`;
        manifest.homepage = base;
        Object.assign(manifest.extensions["com.openai"].interface, {
          websiteURL: base,
          supportURL: `${base}/support`,
          privacyPolicyURL: `${base}/privacy`,
          termsOfServiceURL: `${base}/terms`,
        });
        data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      }
      return { name, data };
    }),
  );

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const entry = zipEntry(file.name, file.data, offset);
    localParts.push(entry.local);
    centralParts.push(entry.central);
    offset += entry.local.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
