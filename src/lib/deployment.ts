import { z } from "zod";

export const gitReference = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value
        .split("/")
        .some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Choose a valid branch name.",
  );
export const healthPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[A-Za-z0-9/._~!$&'()*+,;=:@%?-]*$/)
  .refine(
    (value) => !/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value),
    "Choose a relative health path.",
  );
export const deploymentRequestSchema = z
  .object({
    source: z.enum(["latest", "current"]).default("latest"),
    branch: gitReference.optional(),
    expectedCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
  })
  .strict();
export const ciDeploymentRequestSchema = z
  .object({
    branch: gitReference,
    expectedCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export function redactDeploymentOutput(value: string) {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(
      /\b((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[redacted]",
    );
}

export type DeploymentProgress = {
  type: "source" | "step";
  index?: number;
  label: string;
  status: "running" | "succeeded" | "failed";
  commit?: string;
  output?: string;
  exitCode?: number;
  truncated?: boolean;
};

export type DeploymentResult = {
  source?: {
    status: "updated" | "current";
    commit?: string;
    branch?: string;
    localChanges?: boolean;
  };
  deployment?: {
    exitCode: number;
    timedOut?: boolean;
    startedAt?: string;
    finishedAt?: string;
    steps: {
      label: string;
      command: string;
      exitCode: number;
      output: string;
      timedOut?: boolean;
    }[];
  };
};
