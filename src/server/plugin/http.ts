import type { NextRequest } from "next/server";
import { mcpBrowserRedirect } from "@/server/mcp/browser-redirect";
import {
  registerMcpOAuthClient,
  validateMcpAuthorizationRequest,
  createMcpConsent,
  completeMcpAuthorization,
  exchangeMcpOAuthToken,
  revokeMcpOAuthToken,
  revokeAllMcpConnections,
  parseMcpOAuthForm,
  mcpOAuthErrorResponse,
} from "@/server/mcp/oauth";
import {
  mcpAuthorizationServerMetadata,
  mcpProtectedResourceMetadata,
} from "@/server/mcp/public-url";
import { clientKey, rateLimit } from "@/server/security/request";
import { AppError } from "@/server/cloudpanel/errors";
import { GROUP_LIFETIME, PLUGIN_COOKIE, pluginUrls } from "./config";
import {
  browserGroup,
  createGroup,
  digest,
  groupSubject,
  pluginTransaction,
  requireGroup,
  type PluginGroup,
} from "./store";
import { beginServerLogin, finishServerLogin } from "./login";
import { disconnectServer, revokeRemote } from "./remote";
import { servePluginMcp } from "./server";
import { connectedServers } from "./profile";

const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Panelavo</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#f4f6fb;color:#172033;margin:0;padding:40px 20px}main{max-width:680px;margin:0 auto;background:white;border:1px solid #dfe4ee;border-radius:20px;padding:32px}h1{font-size:28px;line-height:1.2}h2{font-size:20px}a{color:#4f46e5}label{display:block;font-weight:600;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c1d2;border-radius:8px;font:inherit}button{font:inherit;cursor:pointer;background:#4f46e5;color:white;border:0;border-radius:8px;padding:11px 18px;margin:12px 8px 0 0}button.secondary{color:#334155;background:#eef2f7}li{margin:16px 0;overflow-wrap:anywhere}small,.muted{color:#596579}footer{margin-top:28px;border-top:1px solid #e5e7eb;padding-top:14px;font-size:13px}code{overflow-wrap:anywhere}
</style></head><body><main><a href="/connect">Panelavo</a><h1>${escape(title)}</h1>${body}<footer><a href="/connect/privacy">Privacy</a> · <a href="/connect/terms">Terms</a> · <a href="/connect/support">Support</a></footer></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
      },
    },
  );
}
const redirect = (location: string) =>
  new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
function one(form: URLSearchParams, key: string) {
  const values = form.getAll(key);
  if (values.length !== 1 || !values[0])
    throw new Error(`The ${key} field must be supplied once.`);
  return values[0];
}
function cookie(value: string, maxAge = GROUP_LIFETIME / 1000) {
  return `${PLUGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const csrfField = (g: PluginGroup) =>
  `<input type="hidden" name="csrf" value="${escape(g.csrf)}">`;

async function dashboard(group: PluginGroup) {
  const servers = await connectedServers(group.id);
  let consent = "";
  if (group.authorization && group.servers.length) {
    const approval = await createMcpConsent(
      group.authorization,
      groupSubject(group),
    );
    consent = `<section><h2>Connect to ${escape(approval.clientName)}</h2><p>This assistant will be able to use all the servers listed here and servers you add to this connection later, within each account's live website permissions. Returning to <b>${escape(approval.redirectHost)}</b>.</p><form method="post" action="/connect/consent">${csrfField(group)}<input type="hidden" name="consent_token" value="${escape(approval.token)}"><button name="decision" value="approve">Allow connection</button><button class="secondary" name="decision" value="deny">Do not allow</button></form></section>`;
  }
  return page(
    "Your connected servers",
    `<p>Sign in to each server using its own Panelavo login. Your passwords stay on that server.</p>
${servers.length ? `<ul>${servers.map((s) => `<li><strong>${escape(s.label)} · ${escape(s.serverIp ?? "IP unavailable")}</strong><br><small>${escape(s.origin)}</small><br><small>${s.identity ? `${escape(s.identity.username)} · ${escape(s.identity.role)} · ${s.identity.capabilities.manageWebsites ? "Website management" : "Read-only"}${s.identity.capabilities.createWebsites ? " · Can create sites" : ""}` : escape(s.message ?? "Server unavailable")}</small><form method="post" action="/connect/remove">${csrfField(group)}<input type="hidden" name="serverId" value="${s.id}"><button class="secondary">Disconnect server</button></form></li>`).join("")}</ul>` : "<p>No servers connected yet.</p>"}
${consent}<section><h2>Add a server</h2><form method="post" action="/connect/add">${csrfField(group)}<label for="label">Server name</label><input id="label" name="label" maxlength="80" required placeholder="Production"><label for="origin">Panelavo address</label><input id="origin" name="origin" type="url" required placeholder="https://panel.example.com"><button>Continue to Panelavo login</button></form></section>
<p class="muted">Use this browser to manage this connection. It expires after 30 days; reconnect the plugin then. Disconnecting a server here removes its saved credentials. You can also revoke access in that server's AI access page.</p><form method="post" action="/connect/disconnect">${csrfField(group)}<button class="secondary">Disconnect this plugin and all servers</button></form>`,
  );
}

export async function pluginHttp(request: NextRequest) {
  const path = request.nextUrl.pathname;
  try {
    const urls = pluginUrls(request);
    rateLimit(`plugin:${clientKey(request)}`, 300, 60_000);
    if (path === "/connect/openai/mcp") return servePluginMcp(request);
    if (request.method === "GET") {
      if (path === "/.well-known/oauth-authorization-server/connect")
        return json(mcpAuthorizationServerMetadata(urls));
      if (path === "/.well-known/oauth-protected-resource/connect/openai/mcp")
        return json({
          ...mcpProtectedResourceMetadata(urls),
          resource_documentation: `${urls.origin}/connect`,
        });
      const group = await browserGroup(
        request.cookies.get(PLUGIN_COOKIE)?.value,
      );
      if (path === "/connect/authorize") {
        rateLimit(`plugin-authorize:${clientKey(request)}`, 20, 60 * 60_000);
        const authorization = await validateMcpAuthorizationRequest(
          request.nextUrl.searchParams,
          urls,
        );
        if (group?.clientId === authorization.clientId) {
          await pluginTransaction((s) => {
            requireGroup(s, group.id).authorization = authorization;
          });
          return redirect("/connect");
        }
        const created = await createGroup(authorization);
        const response = redirect("/connect");
        response.headers.set("set-cookie", cookie(created.cookie));
        return response;
      }
      if (path === "/connect/callback") {
        if (!group)
          throw new Error(
            "Return to the browser where you started this connection.",
          );
        if (request.nextUrl.searchParams.has("error"))
          return page(
            "Sign-in was not completed",
            '<p>The server did not approve access. <a href="/connect">Return to connected servers</a> to try again.</p>',
            400,
          );
        await finishServerLogin(
          group.browserHash,
          one(request.nextUrl.searchParams, "state"),
          one(request.nextUrl.searchParams, "code"),
          request.nextUrl.searchParams.get("iss") ?? undefined,
        );
        return redirect("/connect");
      }
      if (path === "/connect")
        return group
          ? dashboard(group)
          : page(
              "Panelavo for ChatGPT and Codex",
              `<p>Connect your Panelavo servers, sign in with each server's existing account, and manage your websites from your assistant.</p><p>Start by installing the Panelavo plugin in ChatGPT or Codex and choosing Connect. That opens this page with a secure connection request. You can sign in to multiple servers during setup.</p><p>This service does not request an OpenAI API key or sell subscriptions. Your existing server hosting and ChatGPT/Codex usage limits still apply.</p><p>Developer: ${escape(process.env.PANELAVO_PLUGIN_PUBLISHER || "Panelavo")}</p>`,
            );
      if (path === "/connect/privacy")
        return page(
          "Plugin privacy",
          `<p>The Panelavo plugin connection service stores encrypted OAuth access and refresh tokens for servers you explicitly connect, their addresses and labels, and a random connection-group identifier. It does not collect your Panelavo passwords or create a separate user account database.</p><p>Tool requests and responses pass between your assistant and the selected Panelavo server. They may include website files, logs, database information, or environment values when your server account permits access. OpenAI and the selected server process that information under their respective policies. Only connect servers you trust.</p><p>Connections expire after 30 days. Expired records are removed when the service next accesses its store. Disconnecting through this page removes saved server credentials immediately and attempts to revoke them at their originating server; if the server is offline, revoke its AI connection there when it is available. A random profile identifier and a one-way hash of the connected server/account set are retained across disconnections so the same profile can be recognized after reconnecting. This association contains no tokens, passwords, roles, or website data. Server and infrastructure logs and operator backups may have their own retention periods.</p><p>To remove the complete connection, use “Disconnect this plugin and all servers”. Service operator: ${escape(process.env.PANELAVO_PLUGIN_PUBLISHER || "Panelavo")}.</p>`,
        );
      if (path === "/connect/terms")
        return page(
          "Using the Panelavo plugin",
          `<p>Use the plugin only with servers and websites you are authorized to manage. Each server's current account permissions apply. Follow your hosting provider's terms and the terms of ChatGPT or Codex.</p><p>Website changes may affect live services. Review the selected server and requested action, and keep appropriate backups. Destructive actions retain the originating server's confirmation.</p><p>The connection service does not collect payments or require an OpenAI API key. Existing hosting charges, resource limits, and ChatGPT/Codex usage charges remain governed by your respective providers. Availability depends on those services and your connected Panelavo servers.</p>`,
        );
      if (path === "/connect/support")
        return page(
          "Plugin support",
          '<p>If a server is unavailable, check its Panelavo address and HTTPS certificate. If access expired, disconnect that server here and add it again through its browser login.</p><p>For permission problems, contact that Panelavo server’s administrator. For an unexpected action, revoke the connection in the server’s AI access page. Report plugin defects in the <a href="https://github.com/mehebub648/Panelavo/issues">Panelavo issue tracker</a>. Never include passwords, tokens, environment values, or private website files.</p><p><a href="/connect">Manage this connection</a></p>',
        );
    }
    if (request.method === "POST") {
      if (path === "/connect/register") {
        rateLimit(`plugin-register:${clientKey(request)}`, 20, 60 * 60_000);
        if (
          !(request.headers.get("content-type") ?? "").startsWith(
            "application/json",
          )
        )
          throw new Error("Client registration requires JSON.");
        const text = await request.text();
        if (Buffer.byteLength(text) > 32 * 1024)
          throw new Error("Client registration is too large.");
        return json(await registerMcpOAuthClient(JSON.parse(text)), 201);
      }
      const form = await parseMcpOAuthForm(request);
      if (path === "/connect/token" || path === "/connect/revoke") {
        if (request.headers.has("authorization"))
          throw new Error(
            "Public OAuth clients must not use client authentication.",
          );
        if (path === "/connect/token")
          return json(await exchangeMcpOAuthToken(form, urls));
        await revokeMcpOAuthToken(form);
        return json({});
      }
      if (
        request.headers.get("origin") !== urls.origin ||
        !["same-origin", "none", null].includes(
          request.headers.get("sec-fetch-site"),
        )
      )
        throw new AppError(
          "FORBIDDEN",
          "Cross-origin connection changes are not allowed.",
          403,
        );
      const group = await browserGroup(
        request.cookies.get(PLUGIN_COOKIE)?.value,
      );
      if (!group || digest(one(form, "csrf")) !== digest(group.csrf))
        throw new AppError(
          "FORBIDDEN",
          "The browser session expired. Reconnect the plugin.",
          403,
        );
      if (path === "/connect/add") {
        rateLimit(`plugin-login:${group.id}`, 30, 60 * 60_000);
        return mcpBrowserRedirect(
          await beginServerLogin(
            group.id,
            group.browserHash,
            { origin: one(form, "origin"), label: one(form, "label") },
            urls.origin,
          ),
        );
      }
      if (path === "/connect/remove") {
        await disconnectServer(group.id, one(form, "serverId"));
        return redirect("/connect");
      }
      if (path === "/connect/disconnect") {
        const subject = groupSubject(group);
        await revokeAllMcpConnections(subject.id, subject.username);
        await pluginTransaction((s) => {
          s.groups = s.groups.filter((g) => g.id !== group.id);
          s.logins = s.logins.filter((l) => l.groupId !== group.id);
        });
        await Promise.allSettled(group.servers.map(revokeRemote));
        const response = redirect("/connect");
        response.headers.set("set-cookie", cookie("", 0));
        return response;
      }
      if (path === "/connect/consent") {
        if (!group.authorization || !group.servers.length)
          throw new Error(
            "Add a Panelavo server before allowing the connection.",
          );
        const decision = one(form, "decision");
        if (decision !== "approve" && decision !== "deny")
          throw new Error("Choose whether to allow this connection.");
        const location = await completeMcpAuthorization(
          one(form, "consent_token"),
          decision,
          groupSubject(group),
        );
        await pluginTransaction((s) => {
          requireGroup(s, group.id).authorization = undefined;
        });
        return mcpBrowserRedirect(location);
      }
    }
    return page(
      "Page not found",
      '<p><a href="/connect">Return to Panelavo</a></p>',
      404,
    );
  } catch (error) {
    if (
      [
        "/connect/token",
        "/connect/register",
        "/connect/revoke",
        "/connect/openai/mcp",
      ].includes(path)
    )
      return mcpOAuthErrorResponse(error);
    return page(
      "Connection needs attention",
      `<p>${escape(error instanceof Error ? error.message : "The connection could not continue.")}</p><p><a href="/connect">Return to connected servers</a></p>`,
      error instanceof AppError ? error.status : 400,
    );
  }
}
