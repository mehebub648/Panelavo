import { z } from "zod";

export function normalizeDomain(value: string) {
  let input = value.trim().toLowerCase();
  if (/^https?:\/\//i.test(input)) input = input.replace(/^https?:\/\//i, "");
  return input.replace(/\.$/, "");
}

export const domainValue = z
  .string()
  .transform(normalizeDomain)
  .superRefine((domain, ctx) => {
    if (
      !domain ||
      domain.length > 253 ||
      /[\s\x00-\x1f\x7f*]/.test(domain) ||
      /[/?#:@\\$`;&|<>]/.test(domain)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid domain without a path, port, or wildcard.",
      });
      return;
    }
    const labels = domain.split(".");
    if (
      labels.length < 2 ||
      labels.some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Enter a valid domain, such as example.com.",
      });
    }
  });

const password = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128)
  .refine(
    (v) => !/[\x00-\x1f\x7f]/.test(v),
    "Password contains an unsupported character.",
  );
const runtime = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/);
// The panel derives the primary (system) domain, site user, and application
// port from the reserved site id — the user only picks a category and,
// optionally, their own customer-facing domains, which become aliases.
const categoryId = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/);
export const aliasList = z.array(domainValue).max(10).default([]);
const shared = {
  category: categoryId,
  aliases: aliasList,
  siteUserPassword: password,
};

const proxyUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((value, ctx) => {
    if (/[\r\n\x00-\x1f\x7f`$;&|<>]/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "The proxy URL contains unsupported characters.",
      });
      return;
    }
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Use a valid HTTP or HTTPS URL.",
      });
    }
  });

export const createSiteSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("php"),
      ...shared,
      phpVersion: runtime,
      vhostTemplate: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9 ._-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("nodejs"),
      ...shared,
      nodeVersion: runtime,
    })
    .strict(),
  z.object({ type: z.literal("static"), ...shared }).strict(),
  z
    .object({
      type: z.literal("python"),
      ...shared,
      pythonVersion: runtime,
    })
    .strict(),
  z
    .object({
      type: z.literal("reverse-proxy"),
      ...shared,
      reverseProxyUrl: proxyUrl.optional(),
    })
    .strict(),
  z.object({ type: z.literal("docker"), ...shared }).strict(),
]);

export type ValidCreateSiteInput = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = z
  .object({
    rootDirectory: z
      .string()
      .trim()
      .max(200)
      .regex(/^\/?[a-zA-Z0-9._/-]*$/, "Use a relative directory path.")
      .refine(
        (value) => !value.split("/").includes(".."),
        "The directory must stay inside this website's htdocs folder.",
      )
      .optional(),
    runtimeVersion: runtime.optional(),
    appPort: z.coerce.number().int().min(1024).max(65535).optional(),
    reverseProxyUrl: proxyUrl.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "Provide at least one setting to update.",
  });
