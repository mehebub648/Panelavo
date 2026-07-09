import { getZones, setARecord, mutateRecord, checkARecord } from "./store";
import { load } from "node:fs/promises"; // I need to get all users

export async function setPanelARecord(input: { name: string; ip: string; replace?: boolean }) {
  // Not fully implemented yet
  return null;
}

export async function deletePanelARecord(name: string) {
  return null;
}
