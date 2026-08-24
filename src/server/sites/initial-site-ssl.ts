import type { CloudPanelSession } from "@/types/cloudpanel";
import { issueSiteSsl, planSiteSsl } from "./ensure-ssl";

type InitialSiteSslInput = {
  userId: string;
  systemDomain: string;
  aliases: string[];
  serverIp: string;
};

const retryWarning =
  'The website was created, but Let\'s Encrypt could not be issued automatically. Open Security and use "Issue Let\'s Encrypt" to retry.';

export async function secureCreatedSite(
  session: CloudPanelSession,
  input: InitialSiteSslInput,
) {
  try {
    const plan = await planSiteSsl({ ...input, autoPoint: true });
    try {
      // Creation does not report completion until the issuance attempt has
      // finished, so the site is ready with its certificate whenever ACME is.
      await issueSiteSsl(session, input.systemDomain, plan.san);
      return plan.warnings;
    } catch (error) {
      console.error(
        `Let's Encrypt issuance failed for new site ${input.systemDomain}:`,
        error,
      );
      return [...plan.warnings, retryWarning];
    }
  } catch (error) {
    console.error(
      `Let's Encrypt preparation failed for new site ${input.systemDomain}:`,
      error,
    );
    return [retryWarning];
  }
}
