// Admin backend (Cloudflare Worker), on the admin subdomain.
//
//   POST /api/login           { email, password } -> sets the session cookie
//   GET  /api/oauth/google/start      "Sign in with Google"
//   GET  /api/oauth/google/callback   Google sends the user back here
//   POST /api/logout
//   GET  /api/session         is the visitor logged in?
//   GET  /api/catalog         settings + all products     (login required)
//   PUT  /api/products        save the product list        (login required)
//   PUT  /api/settings        save the shop settings       (login required)
//   POST /api/photos?name=..  upload a photo (raw body)    (login required)
//   GET  /preview/<path>      a shop photo, for previews in the panel
//
// The admin backend stores nothing itself: every read and change goes to the
// storefront backend's private API (/internal/*), through the SHOP_API service
// binding, authenticated with the shared INTERNAL_API_KEY.
//
// Everything else is a static file from public/.

const SESSION_COOKIE = "admin_session";
const SESSION_HOURS = 12;
const MAX_BODY_BYTES = 6 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname.startsWith("/api/")) return await api(request, env, url);
      if (pathname.startsWith("/preview/") && request.method === "GET") return await preview(env, pathname.slice(9));
    } catch (err) {
      if (err.status === 413) return json({ error: "That file is too large." }, 413);
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

async function api(request, env, url) {
  const route = url.pathname.slice(5);
  const method = request.method;

  // Only accept changes sent by the admin panel itself (blocks cross-site forms).
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Forbidden" }, 403);
  }

  if (route === "login" && method === "POST") return login(request, env, url);
  if (route === "oauth/google/start" && method === "GET") return googleStart(env, url);
  if (route === "oauth/google/callback" && method === "GET") return googleCallback(request, env, url);
  if (route === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0, url) });
  }

  const loggedIn = await hasSession(request, env);
  if (route === "session" && method === "GET") {
    return json({ loggedIn, shopUrl: env.SHOP_URL || "", methods: loginMethods(env) });
  }
  if (!loggedIn) return json({ error: "Please log in again." }, 401);

  if (route === "catalog" && method === "GET") return shop(env, "GET", "catalog");
  if (route === "products" && method === "PUT") return shop(env, "PUT", "products", await body(request), "application/json");
  if (route === "settings" && method === "PUT") return shop(env, "PUT", "settings", await body(request), "application/json");
  if (route === "photos" && method === "POST") {
    const name = encodeURIComponent(url.searchParams.get("name") || "photo");
    return shop(env, "POST", "photos?name=" + name, await body(request), request.headers.get("Content-Type") || "");
  }
  return json({ error: "Not found" }, 404);
}

/* ---------- Talking to the storefront backend ---------- */

async function shop(env, method, route, payload, contentType) {
  if (!env.INTERNAL_API_KEY) return json({ error: "Admin setup incomplete. Add INTERNAL_API_KEY under Settings → Variables and Secrets on this Worker." }, 500);
  const headers = { "X-Internal-Key": env.INTERNAL_API_KEY };
  if (contentType) headers["Content-Type"] = contentType;
  const req = new Request("https://shop.internal/internal/" + route, { method, headers, body: payload });
  let res;
  try {
    // Normally a service binding; SHOP_API_URL is a fallback for setups without one.
    res = env.SHOP_API ? await env.SHOP_API.fetch(req) : await fetch(new Request(new URL("/internal/" + route, env.SHOP_API_URL), req));
  } catch (err) {
    console.error("Shop API unreachable", err);
    return json({ error: "Could not reach the shop backend." }, 502);
  }
  if (res.status === 403) return json({ error: "The shop backend refused the request. Check that INTERNAL_API_KEY is the same on both backends." }, 502);
  // Pass the shop backend's answer straight through.
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function preview(env, path) {
  if (!/^(images|photos)\/[a-z0-9._/-]+$/i.test(path) || path.includes("..")) return new Response("Not found", { status: 404 });
  const res = env.SHOP_API
    ? await env.SHOP_API.fetch(new Request("https://shop.internal/" + path))
    : await fetch(new URL("/" + path, env.SHOP_API_URL));
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") || "", "Cache-Control": "private, max-age=3600" } });
}

/* ---------- Login and sessions ---------- */

async function login(request, env, url) {
  const missing = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET"].filter((name) => !env[name]);
  if (missing.length) {
    return json({ error: `Admin setup incomplete. Add ${missing.join(", ")} under Settings → Variables and Secrets on this Worker.` }, 500);
  }
  let email = "", password = "";
  try {
    const body = await request.json();
    email = String(body.email || "").trim().toLowerCase();
    password = String(body.password || "");
  } catch {}
  // Compare hashes so the check takes the same time whatever was typed, and
  // check both before answering so the reply doesn't reveal which was wrong.
  let emailOk = false;
  for (const allowed of adminEmails(env)) {
    if (safeEqual(await sha256(email), await sha256(allowed))) emailOk = true;
  }
  const passwordOk = safeEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD));
  if (!(emailOk && passwordOk)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json({ error: "Wrong email or password." }, 401);
  }
  const token = await signSession(env, Date.now() + SESSION_HOURS * 3600 * 1000);
  return json({ ok: true, shopUrl: env.SHOP_URL || "" }, 200, { "Set-Cookie": cookie(token, SESSION_HOURS * 3600, url) });
}

/* ---------- Sign in with Google (OAuth 2.0 / OpenID Connect) ---------- */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_COOKIE = "admin_oauth";

// ADMIN_EMAIL can hold several addresses separated by commas.
function adminEmails(env) {
  return String(env.ADMIN_EMAIL || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function loginMethods(env) {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ADMIN_EMAIL),
    password: !!(env.ADMIN_PASSWORD && env.ADMIN_EMAIL),
  };
}

async function googleStart(env, url) {
  if (!loginMethods(env).google || !env.SESSION_SECRET) {
    return backToLogin(url, "Google sign-in isn't set up. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAIL and SESSION_SECRET.");
  }
  const state = randomToken();
  const verifier = randomToken() + randomToken();
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/api/oauth/google/callback",
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: GOOGLE_AUTH + "?" + params,
      // Remembered for 10 minutes so the callback can check the reply is ours.
      "Set-Cookie": `${OAUTH_COOKIE}=${state}.${verifier}; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
    },
  });
}

async function googleCallback(request, env, url) {
  const saved = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${OAUTH_COOKIE}=([^;]+)`));
  const [state, verifier] = saved ? saved[1].split(".") : [];
  const clear = `${OAUTH_COOKIE}=; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (url.searchParams.get("error")) return backToLogin(url, "Google sign-in was cancelled.", clear);
  const code = url.searchParams.get("code");
  if (!code || !state || !verifier || !safeEqual(url.searchParams.get("state") || "", state)) {
    return backToLogin(url, "Sign-in expired or didn't start here. Please try again.", clear);
  }

  let tokens;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + "/api/oauth/google/callback",
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    tokens = await res.json();
  } catch (err) {
    console.error("Google token exchange failed", err);
    return backToLogin(url, "Couldn't reach Google. Please try again.", clear);
  }

  // The ID token comes straight from Google over HTTPS, so its claims can be
  // read directly; we still check who issued it, for whom, and that it's current.
  const claims = decodeJwt(tokens && tokens.id_token);
  const now = Date.now() / 1000;
  if (!claims || claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || !(claims.exp > now)) {
    return backToLogin(url, "Google sign-in failed. Please try again.", clear);
  }
  const email = String(claims.email || "").toLowerCase();
  if (!claims.email_verified || !adminEmails(env).includes(email)) {
    return backToLogin(url, `${email || "This Google account"} isn't allowed to use the admin console.`, clear);
  }

  const token = await signSession(env, Date.now() + SESSION_HOURS * 3600 * 1000);
  return redirectPage("/", [clear, cookie(token, SESSION_HOURS * 3600, url)]);
}

function backToLogin(url, message, clearCookie) {
  return redirectPage("/?login_error=" + encodeURIComponent(message), clearCookie ? [clearCookie] : []);
}

// A tiny page that forwards to the admin console. Used instead of a plain
// redirect so the browser treats the next page load as same-site and sends
// the (SameSite=Strict) session cookie.
function redirectPage(location, cookies) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  const target = JSON.stringify(location).replace(/</g, "\\u003c");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p><script>location.replace(${target})</script>`,
    { status: 200, headers }
  );
}

function decodeJwt(jwt) {
  try {
    const part = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(part + "===".slice((part.length + 3) % 4)), (c) => c.charCodeAt(0)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

async function hasSession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [expires, signature] = match[1].split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return safeEqual(signature, await hmac(env.SESSION_SECRET, expires));
}

async function signSession(env, expires) {
  return `${expires}.${await hmac(env.SESSION_SECRET, String(expires))}`;
}

function cookie(value, maxAge, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/* ---------- Helpers ---------- */

async function body(request) {
  const data = await request.arrayBuffer();
  if (data.byteLength > MAX_BODY_BYTES) throw Object.assign(new Error("Body too large"), { status: 413 });
  return data;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function sha256(text) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function base64url(buffer) {
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
