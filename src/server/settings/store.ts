import { jsonStore } from "@/server/storage/json-store";

// Panel-wide settings. Environment values seed fresh/manual deployments;
// persisted values remain authoritative after an operator changes them.

type StoredSettings = {
  baseDomain?: string;
  updateRepository?: string;
  wildcardRegistrationEndpoint?: string;
  wildcardRegistrationBaseDomain?: string;
  security?: Partial<SecuritySettings>;
};

export type SecuritySettings = {
  sessionLifetimeMinutes: number;
  passwordMinLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
};

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  sessionLifetimeMinutes: 60,
  passwordMinLength: 12,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSymbol: false,
};

export type PanelSettings = {
  baseDomain: string;
  updateRepository: string;
  wildcardRegistrationEndpoint: string;
  wildcardRegistrationBaseDomain: string;
};

const store = jsonStore<StoredSettings>(
  "panel-settings.json",
  () => ({}),
  (value) =>
    value && typeof value === "object" ? (value as StoredSettings) : {},
);

export async function getPanelSettings(): Promise<PanelSettings> {
  const stored = await store.load();
  return {
    baseDomain:
      stored.baseDomain ||
      process.env.PANEL_BASE_DOMAIN?.trim().toLowerCase() ||
      "",
    updateRepository:
      stored.updateRepository ||
      process.env.PANEL_UPDATE_REPOSITORY?.trim() ||
      "",
    wildcardRegistrationEndpoint:
      stored.wildcardRegistrationEndpoint ||
      process.env.PANEL_WILDCARD_REGISTRATION_ENDPOINT?.trim() ||
      "",
    wildcardRegistrationBaseDomain:
      stored.wildcardRegistrationBaseDomain ||
      process.env.PANEL_WILDCARD_REGISTRATION_BASE_DOMAIN?.trim().toLowerCase() ||
      "",
  };
}

export async function getBaseDomain(): Promise<string> {
  return (await getPanelSettings()).baseDomain;
}

export async function setBaseDomain(baseDomain: string) {
  const stored = await store.load();
  stored.baseDomain = baseDomain.trim().toLowerCase();
  await store.save(stored);
}

export async function setUpdateRepository(updateRepository: string) {
  const stored = await store.load();
  stored.updateRepository = updateRepository.trim();
  await store.save(stored);
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  const stored = await store.load();
  const value = stored.security ?? {};
  return {
    sessionLifetimeMinutes:
      Number.isInteger(value.sessionLifetimeMinutes) &&
      Number(value.sessionLifetimeMinutes) >= 15 &&
      Number(value.sessionLifetimeMinutes) <= 10_080
        ? Number(value.sessionLifetimeMinutes)
        : Math.max(
            15,
            Math.min(
              10_080,
              Math.round(
                Number(process.env.SESSION_MAX_AGE_SECONDS ?? 3600) / 60,
              ),
            ),
          ),
    passwordMinLength:
      Number.isInteger(value.passwordMinLength) &&
      Number(value.passwordMinLength) >= 12 &&
      Number(value.passwordMinLength) <= 128
        ? Number(value.passwordMinLength)
        : DEFAULT_SECURITY_SETTINGS.passwordMinLength,
    requireUppercase: value.requireUppercase === true,
    requireLowercase: value.requireLowercase === true,
    requireNumber: value.requireNumber === true,
    requireSymbol: value.requireSymbol === true,
  };
}

export async function setSecuritySettings(value: SecuritySettings) {
  const stored = await store.load();
  stored.security = value;
  await store.save(stored);
  return getSecuritySettings();
}

export function passwordPolicyError(
  password: string,
  policy: SecuritySettings,
) {
  if (password.length < policy.passwordMinLength || password.length > 128)
    return `Use a password of at least ${policy.passwordMinLength} characters.`;
  if (/[^\x20-\x7e]/.test(password)) return "Use printable characters only.";
  if (policy.requireUppercase && !/[A-Z]/.test(password))
    return "Add an uppercase letter.";
  if (policy.requireLowercase && !/[a-z]/.test(password))
    return "Add a lowercase letter.";
  if (policy.requireNumber && !/[0-9]/.test(password)) return "Add a number.";
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password))
    return "Add a symbol.";
  return null;
}
