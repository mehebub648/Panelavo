import { z } from "zod";
import { jsonStore } from "@/server/storage/json-store";
import { deployHookCommands } from "@/lib/deploy-hooks";

export const deployHookOperationSchema = z
  .object({
    command: z.enum(deployHookCommands),
    script: z
      .string()
      .regex(/^[A-Za-z0-9:._-]{1,64}$/)
      .optional(),
    name: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsScript =
      value.command === "node-run" || value.command === "npm-run";
    const needsName = value.command === "pm2-restart-one";
    if (needsScript !== Boolean(value.script))
      context.addIssue({
        code: "custom",
        path: ["script"],
        message: needsScript
          ? "A package script is required."
          : "This command does not accept a script.",
      });
    if (needsName !== Boolean(value.name))
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: needsName
          ? "A process name is required."
          : "This command does not accept a process name.",
      });
  });
export const deployHooksSchema = z.array(deployHookOperationSchema).max(10);
export type DeployHookOperation = z.infer<typeof deployHookOperationSchema>;
type Store = { sites: Record<string, DeployHookOperation[]> };
const store = jsonStore<Store>(
  "deploy-hooks.json",
  () => ({ sites: {} }),
  (value) => {
    const parsed = z
      .object({ sites: z.record(deployHooksSchema) })
      .parse(value);
    return parsed;
  },
  true,
);

export async function getDeployHooks(domain: string) {
  return (await store.load()).sites[domain.toLowerCase()] ?? [];
}
let mutationQueue: Promise<unknown> = Promise.resolve();
export async function setDeployHooks(domain: string, hooks: unknown) {
  const parsed = deployHooksSchema.parse(hooks);
  const pending = mutationQueue.then(async () => {
    const value = await store.load();
    if (parsed.length) value.sites[domain.toLowerCase()] = parsed;
    else delete value.sites[domain.toLowerCase()];
    await store.save(value);
    return parsed;
  });
  mutationQueue = pending.catch(() => undefined);
  return pending;
}
