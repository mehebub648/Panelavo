import { z } from "zod";

export const loginSchema = z
  .object({
    username: z.string().trim().min(1, "Enter your user name.").max(190),
    password: z.string().min(1, "Enter your password.").max(1024),
  })
  .strict();

export const twoFactorSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter the 6-digit verification code."),
  })
  .strict();
