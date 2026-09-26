// Cloudflare Pages Function: finishes the GitHub login for the admin panel.
// GitHub redirects here with a one-time code; we swap it for an access token
// and hand the token to the admin panel window that opened the login popup.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)decap_oauth_state=([^;]+)/);

  if (!code || !state || !cookieState || cookieState[1] !== state) {
    return reply(url.origin, "error", { message: "Login expired or was not started from this site. Please try again." });
  }

  let data;
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "decap-cms-auth" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: url.origin + "/api/callback",
      }),
    });
    data = await res.json();
  } catch (err) {
    return reply(url.origin, "error", { message: "Could not reach GitHub. Please try again." });
  }

  if (!data.access_token) {
    return reply(url.origin, "error", { message: data.error_description || "GitHub did not return a login token." });
  }
  return reply(url.origin, "success", { token: data.access_token, provider: "github" });
}

// Decap CMS login handshake: announce ourselves, wait for the admin window
// to answer, then post the result back to it (only if it is this site).
function reply(origin, status, content) {
  const message = "authorization:github:" + status + ":" + JSON.stringify(content);
  const html = `<!doctype html><html><body><p>Logging in…</p><script>
(function () {
  var origin = ${JSON.stringify(origin)};
  var message = ${JSON.stringify(message)};
  function receive(e) {
    if (e.origin !== origin) return;
    window.removeEventListener("message", receive, false);
    e.source.postMessage(message, origin);
    setTimeout(function () { window.close(); }, 250);
  }
  window.addEventListener("message", receive, false);
  if (window.opener) window.opener.postMessage("authorizing:github", origin);
})();
</script></body></html>`;
  return new Response(html, {
    status: status === "success" ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": "decap_oauth_state=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}
