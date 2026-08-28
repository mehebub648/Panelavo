import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("database gateway production contract", () => {
  it("keeps the main database private and isolates every public endpoint", async () => {
    const [setup, bridge, service, client] = await Promise.all([
      readFile(join(process.cwd(), "setup.sh"), "utf8"),
      readFile(
        join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
        "utf8",
      ),
      readFile(
        join(process.cwd(), "src", "server", "sites", "site-section-service.ts"),
        "utf8",
      ),
      readFile(
        join(process.cwd(), "src", "server", "cloudpanel", "live-client.ts"),
        "utf8",
      ),
    ]);

    expect(setup).toContain("bind-address=127.0.0.1");
    expect(setup).toContain("mysqlx-bind-address=127.0.0.1");
    expect(setup).toContain("ufw insert 1 deny \"${DATABASE_PORT}/tcp\"");
    expect(setup).toContain("ufw allow 43000:43255/tcp");
    expect(setup).toContain("User=proxysql");
    expect(setup).toContain("NoNewPrivileges=true");
    expect(setup).toContain("ALL ALL=(ALL) !/usr/bin/clpctlWrapper");
    expect(setup).toContain("root ALL=(ALL) NOPASSWD: /usr/bin/clpctlWrapper");
    expect(setup).toContain('monitor_username="${DATABASE_GATEWAY_MONITOR_USER}"');
    expect(setup).toContain('monitor_password="${DATABASE_GATEWAY_MONITOR_PASSWORD}"');
    expect(setup).toContain('hostgroup=10 ; max_connections=1024 ; use_ssl=1');
    expect(setup).toContain("UFW_CONSOLE_RECOVERY_READY=true");

    expect(bridge).toContain("use_ssl,default_hostgroup,default_schema,schema_locked");
    expect(bridge).toContain("frontend,max_connections");
    expect(bridge).toContain("DatabaseUser::PERMISSIONS_READ_ONLY");
    expect(bridge).toContain("DatabaseUser::PERMISSIONS_READ_WRITE");
    expect(bridge).toContain("'proxyPort' => (int) $state['proxyPortStart'] + $slot");
    expect(bridge).toContain("'accessMode' => $accessMode");
    expect(bridge).toContain("$access .= \"        deny all;\\n\"");
    expect(bridge).toContain("proxy_protocol on;");
    expect(bridge).toContain("revokeDatabaseGatewayEndpoint($manager, $database");

    expect(service).toContain('actor.authentication !== "session"');
    expect(service).toContain("verifyPassword(actor.cloudPanel, exposure.currentPassword)");
    expect(service).toContain("delete safeExposure.currentPassword");
    expect(client).not.toContain("data.databaseGatewayReady !== true");
  });
});
