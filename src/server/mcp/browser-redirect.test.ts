import { describe, expect, it } from "vitest";
import { mcpBrowserRedirect } from "./browser-redirect";
describe("OAuth browser handoff", () => {
  it("renders a new document for cross-origin navigation without a POST redirect", async () => {
    const response = mcpBrowserRedirect(
      "https://client.example.com/callback?code=sample&state=test",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("window.location.replace(");
  });
  it("escapes destinations in both HTML and JavaScript contexts", async () => {
    const body = await mcpBrowserRedirect(
      'https://client.example.com/?value=</script><script>alert("test")</script>&state=ok',
    ).text();
    expect(body.match(/<script>/g)).toHaveLength(1);
    expect(body.match(/<\/script>/g)).toHaveLength(1);
    expect(body).toContain("\\u003c/script\\u003e");
    expect(body).toContain("&lt;/script&gt;");
  });
});
