import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceHistoryPoint } from "@/types/cloudpanel";

// In-process resource sampler: one point per minute (CPU / memory / disk
// percentages), kept for 24 hours and mirrored to disk so history survives
// panel restarts. Reading /proc and statfs needs no privileges, so this runs
// inside the Next.js server rather than the root bridge.
const SAMPLE_INTERVAL_MS = 60_000;
const MAX_POINTS = 1_440;
const PERSIST_EVERY = 5;

const historyFile = () =>
  join(process.env.PANEL_DATA_DIR || join(process.cwd(), ".data"), "resource-history.json");

type SamplerState = {
  points: ResourceHistoryPoint[];
  timer?: NodeJS.Timeout;
  lastCpu?: { total: number; idle: number };
  sinceLastPersist: number;
  loaded: boolean;
};

const globalState = globalThis as typeof globalThis & {
  __panelResourceHistory?: SamplerState;
};
const state = (globalState.__panelResourceHistory ??= {
  points: [],
  sinceLastPersist: 0,
  loaded: false,
});

async function loadPersisted() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const parsed = JSON.parse(await readFile(historyFile(), "utf8")) as ResourceHistoryPoint[];
    const cutoff = Date.now() - MAX_POINTS * SAMPLE_INTERVAL_MS;
    if (Array.isArray(parsed) && !state.points.length)
      state.points = parsed.filter((point) => point && typeof point.t === "number" && point.t > cutoff);
  } catch {
    // No history yet.
  }
}

async function persist() {
  try {
    const dir = process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${historyFile()}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state.points), { mode: 0o600 });
    await rename(tmp, historyFile());
  } catch {
    // Best effort; the in-memory buffer remains authoritative.
  }
}

async function readCpu(): Promise<{ total: number; idle: number } | null> {
  try {
    const stat = await readFile("/proc/stat", "utf8");
    const match = /^cpu\s+(.+)$/m.exec(stat);
    if (!match) return null;
    const parts = match[1].trim().split(/\s+/).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    return { total: parts.reduce((sum, value) => sum + value, 0), idle };
  } catch {
    return null;
  }
}

async function sample() {
  try {
    const point: ResourceHistoryPoint = { t: Date.now(), cpu: 0, mem: 0, disk: 0 };
    const cpu = await readCpu();
    if (cpu && state.lastCpu && cpu.total > state.lastCpu.total) {
      const total = cpu.total - state.lastCpu.total;
      const idle = cpu.idle - state.lastCpu.idle;
      point.cpu = Math.round(Math.max(0, Math.min(100, (1 - idle / total) * 100)) * 10) / 10;
    }
    if (cpu) state.lastCpu = cpu;
    try {
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(meminfo)?.[1] ?? 0);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1] ?? 0);
      if (total > 0) point.mem = Math.round(((total - available) / total) * 1000) / 10;
    } catch {}
    try {
      const fs = await statfs("/");
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      if (total > 0) point.disk = Math.round(((total - free) / total) * 1000) / 10;
    } catch {}
    state.points.push(point);
    if (state.points.length > MAX_POINTS) state.points.splice(0, state.points.length - MAX_POINTS);
    if (++state.sinceLastPersist >= PERSIST_EVERY) {
      state.sinceLastPersist = 0;
      await persist();
    }
  } catch {
    // Never let sampling take the server down.
  }
}

export async function ensureResourceSampler() {
  await loadPersisted();
  if (state.timer) return;
  state.timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  state.timer.unref?.();
  // Prime the CPU counters immediately so the first minute produces a point.
  void sample();
}

export async function getResourceHistory(): Promise<ResourceHistoryPoint[]> {
  await ensureResourceSampler();
  return state.points;
}
