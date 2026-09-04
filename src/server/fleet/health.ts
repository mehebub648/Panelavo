import { z } from "zod";
import { getResourceHistory } from "@/server/system/resource-history";

const percentage = z.number().finite().min(0).max(100);
const healthSchema = z.object({
  healthOnly: z.literal(true),
  resourceSample: z
    .object({
      t: z.number(),
      cpu: percentage,
      mem: percentage,
      disk: percentage,
    })
    .nullable(),
});
export type FleetHealthReport = z.infer<typeof healthSchema>;

// Reuse the shared minute sampler; never enumerate websites, software, or
// containers just to establish that an authenticated remote panel is alive.
export async function getFleetHealthReport(): Promise<FleetHealthReport> {
  const latest = (await getResourceHistory()).at(-1);
  const fresh =
    latest && Date.now() - latest.t >= 0 && Date.now() - latest.t <= 120_000;
  return { healthOnly: true, resourceSample: fresh ? latest : null };
}

export function fleetHealthPressured(value: unknown) {
  if (value && typeof value === "object" && "healthOnly" in value) {
    const { resourceSample } = healthSchema.parse(value);
    return (
      resourceSample !== null &&
      Math.max(resourceSample.cpu, resourceSample.mem, resourceSample.disk) >=
        90
    );
  }
  // Older peers ignore healthOnly and return their existing full summary.
  const metric = z.object({ usedPercent: percentage });
  const { resources } = z
    .object({
      resources: z.object({ cpu: metric, memory: metric, disk: metric }),
    })
    .parse(value);
  return (
    Math.max(
      resources.cpu.usedPercent,
      resources.memory.usedPercent,
      resources.disk.usedPercent,
    ) >= 90
  );
}
