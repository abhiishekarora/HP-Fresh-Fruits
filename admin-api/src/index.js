// Admin backend (Cloudflare Worker), on the admin subdomain.
//
//   POST /api/login           { password } -> sets the session cookie
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
// Everything else is a static file from ../admin.

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
  if (route === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0, url) });
  }

  const loggedIn = await hasSession(request, env);
  if (route === "session" && method === "GET") {
    return json({ loggedIn, shopUrl: env.SHOP_URL || "" });
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
  if (!env.INTERNAL_API_KEY) return json({ error: "The admin backend is missing INTERNAL_API_KEY." }, 500);
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
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "The admin backend is missing ADMIN_PASSWORD or SESSION_SECRET." }, 500);
  }
  let password = "";
  try {
    password = String((await request.json()).password || "");
  } catch {}
  // Compare hashes so the check takes the same time whatever was typed.
  const ok = safeEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // slow down password guessing
    return json({ error: "Wrong password." }, 401);
  }
  const token = await signSession(env, Date.now() + SESSION_HOURS * 3600 * 1000);
  return json({ ok: true, shopUrl: env.SHOP_URL || "" }, 200, { "Set-Cookie": cookie(token, SESSION_HOURS * 3600, url) });
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
