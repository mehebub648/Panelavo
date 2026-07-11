export type AppErrorCode =
  | "INVALID_CREDENTIALS"
  | "TWO_FACTOR_REQUIRED"
  | "INVALID_TWO_FACTOR_CODE"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "INVALID_DOMAIN"
  | "DOMAIN_ALREADY_EXISTS"
  | "INVALID_SITE_TYPE"
  | "INVALID_RUNTIME_VERSION"
  | "INVALID_SITE_USER"
  | "INVALID_PROXY_URL"
  | "CLOUDPANEL_UNAVAILABLE"
  | "CLOUDPANEL_VERSION_UNSUPPORTED"
  | "SITE_CREATION_FAILED"
  | "SITE_NOT_FOUND"
  | "SITE_UPDATE_FAILED"
  | "REQUEST_TIMEOUT"
  | "PANEL_UPDATING"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function publicMessage(error: unknown) {
  if (error instanceof AppError)
    return { code: error.code, message: error.message, status: error.status };
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    const first = error.issues[0] as { message?: string } | undefined;
    return {
      code: "INVALID_REQUEST" as const,
      message: first?.message ?? "Check the submitted fields and try again.",
      status: 400,
    };
  }
  return {
    code: "INTERNAL_ERROR" as const,
    message: "Something went wrong. Please try again.",
    status: 500,
  };
}
