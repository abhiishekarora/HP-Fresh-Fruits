// Cloudflare Pages Function: starts the GitHub login for the admin panel.
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET set as environment
// variables in the Cloudflare Pages project (see README).

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID) {
    return new Response("GitHub login is not configured: set GITHUB_CLIENT_ID.", { status: 500 });
  }
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: url.origin + "/api/callback",
    scope: "repo,user",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: "https://github.com/login/oauth/authorize?" + params,
      // Checked in callback.js so a login can't be started by another site.
      "Set-Cookie": `decap_oauth_state=${state}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
