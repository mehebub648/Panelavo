/** Finish a validated OAuth form without relaxing the browser's form-action policy. */
export function mcpBrowserRedirect(location: string) {
  const href = location.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
  const scriptValue = JSON.stringify(location).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  // A cross-origin 303 after a POST is blocked by form-action 'self' in Chrome.
  // Render a new document first, then navigate to the already-validated URL.
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Continue · Panelavo</title></head><body><p><a href="${href}">Continue to your application</a></p><script>window.location.replace(${scriptValue});</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
