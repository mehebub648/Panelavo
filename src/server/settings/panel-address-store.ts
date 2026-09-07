import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PanelAddressState = {
  origin?: string;
  previousOrigins: string[];
  revision: number;
  pending?: {
    origin: string;
    previousOrigin: string;
    revision: number;
    completed: string[];
  };
  proof?: { challenge: string; response: string; expiresAt: number };
};
const directory = () =>
  process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
export function getPanelAddressState(): PanelAddressState {
  try {
    return JSON.parse(
      readFileSync(join(directory(), "panel-address.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { previousOrigins: [], revision: 0 };
  }
}
export function savePanelAddressState(state: PanelAddressState) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const file = join(directory(), "panel-address.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, file);
}
