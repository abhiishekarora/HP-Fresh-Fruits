// Storefront backend (Cloudflare Worker).
//
// Public, called by the shop's pages:
//   GET  /api/catalog          shop settings + visible products
//   POST /api/orders           create an order and email its initial status
//   POST /api/auth/register    create a customer account (signs in)
//   POST /api/auth/login       { email, password } -> sets the session cookie
//   POST /api/auth/logout
//   POST /api/auth/forgot      email a password reset link
//   POST /api/auth/reset       { token, password } -> new password, signs in
//   GET  /api/account          the signed-in customer, or null
//   GET  /api/account/orders   the signed-in customer's orders
//   GET  /photos/<name>        a photo uploaded through the admin panel
//
// Private, called only by the admin backend (header X-Internal-Key):
//   GET    /internal/catalog   settings + all products, hidden ones included
//   PUT    /internal/products  replace the product list
//   PUT    /internal/settings  replace the shop settings
//   GET    /internal/orders    recent orders
//   PUT    /internal/orders/<id> update order status
//   GET    /internal/report?from=<ms>&to=<ms>  orders, catalogue and customers for a report
//   POST   /internal/throttle  rate limiting for admin sign-in
//   POST   /internal/photos    upload a photo (raw image body)
//   DELETE /internal/photos/<name>
//
// Everything else is a static file of the website (repository root).
//
// Data lives in the SHOP_DATA KV namespace. Until the admin panel saves for
// the first time, the catalogue comes from the bundled data/*.json files.

const STOCK = ["in_stock", "limited", "new", "sold_out"];
const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ORDER_BYTES = 32 * 1024;
const ORDER_STATUSES = ["received", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];
const ORDER_STATUS_LABELS = {
  received: "Order received",
  confirmed: "Confirmed",
  preparing: "Preparing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const SESSION_COOKIE = "shop_session";
const SESSION_DAYS = 30;
// Workers caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;
const MAX_REPORT_ORDERS = 900; // stays under the per-request KV operation limit
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname.startsWith("/api/") && request.method !== "GET") {
        // Changes must come from the shop's own pages, as JSON (blocks cross-site forms).
        if (request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
        const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json") return json({ error: "Expected JSON." }, 415);
      }
      if (pathname === "/api/catalog" && request.method === "GET") return await publicCatalog(env);
      if (pathname === "/api/orders" && request.method === "POST") return await createOrder(request, env);
      if (pathname.startsWith("/api/auth/") || pathname === "/api/account" || pathname.startsWith("/api/account/")) {
        return await account(request, env, url, pathname.slice(5));
      }
      if (pathname.startsWith("/photos/") && request.method === "GET") return await servePhoto(env, pathname.slice(8));
      if (pathname.startsWith("/internal/")) return await internal(request, env, pathname.slice(10));
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      if (err.status === 413) return json({ error: "Request body is too large." }, 413);
      return json({ error: "Server error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------- Public ---------- */

async function publicCatalog(env) {
  const [settings, products] = await Promise.all([loadDoc(env, "settings"), loadDoc(env, "products")]);
  return json(
    { settings, products: products.filter((p) => p.visible !== false) },
    200,
    // Short cache so admin changes show up within a minute.
    { "Cache-Control": "public, max-age=30" }
  );
}

async function createOrder(request, env) {
  // Each order can send an email, so limit how often one visitor can order.
  if (await throttle(env, "order", clientIp(request), 10, 3600)) {
    return json({ error: "Too many orders from your connection. Please try again later or contact us." }, 429);
  }
  const body = await readJson(request, MAX_ORDER_BYTES);
  if (!body || typeof body !== "object") return json({ error: "Invalid order details." }, 400);
  const session = await currentCustomer(request, env);
  const [settings, products] = await Promise.all([loadDoc(env, "settings"), loadDoc(env, "products")]);
  const cleaned = cleanOrder(body, products);
  if (cleaned.error) return json({ error: cleaned.error }, 400);
  const minimum = Number(settings.minOrder && settings.minOrder.value);
  if (Number.isFinite(minimum) && minimum > 0) {
    const actual = settings.minOrder.unit === "amount"
      ? cleaned.subtotal
      : cleaned.items.reduce((count, item) => count + item.quantity, 0);
    if (actual < minimum) return json({ error: "Your cart doesn't meet the minimum order requirement." }, 400);
  }

  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/\D/g, "")}-${crypto.randomUUID()}`;
  const order = {
    id,
    createdAt,
    updatedAt: createdAt,
    status: "received",
    customer: cleaned.customer,
    customerId: session ? session.customer.id : null,
    items: cleaned.items,
    subtotal: cleaned.subtotal,
    hasUnpricedItems: cleaned.hasUnpricedItems,
    currency: settings.currency || { code: "INR", locale: "en-IN" },
  };
  await env.SHOP_DATA.put("order:" + id, JSON.stringify(order), {
    metadata: { createdAt, status: order.status },
  });
  if (session) await linkOrderToCustomer(env, session.customer, order);
  const emailSent = await sendOrderEmail(env, order, "received");
  return json({ ok: true, orderId: id, status: order.status, emailSent }, 201);
}

function cleanOrder(body, products) {
  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const name = text(customer.name, 100);
  const email = String(customer.email || "").trim().toLowerCase();
  const phone = text(customer.phone, 40);
  const address = text(customer.address, 300);
  if (!name || !EMAIL_RE.test(email) || email.length > 254 || !phone || !address) {
    return { error: "Enter a valid name, email, phone number, and delivery address." };
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return { error: "Your cart is empty or contains too many items." };
  }

  const byId = new Map(products.map((product) => [product.id, product]));
  const seen = new Set();
  const items = [];
  let subtotal = 0;
  let hasUnpricedItems = false;
  for (const item of body.items) {
    if (!item || typeof item.id !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || seen.has(item.id)) {
      return { error: "One or more cart items are invalid. Please refresh the shop and try again." };
    }
    seen.add(item.id);
    const product = byId.get(item.id);
    if (!product || product.visible === false || product.stock === "sold_out") {
      return { error: "A cart item is no longer available. Please refresh the shop and try again." };
    }
    const price = product.price === null || product.price === "" || product.price === undefined ? null : Number(product.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) return { error: "A product has an invalid price." };
    if (price === null) hasUnpricedItems = true;
    else subtotal += price * item.quantity;
    items.push({
      id: product.id,
      name: text(product.name, 100),
      unit: text(product.unit, 40),
      quantity: item.quantity,
      price,
    });
  }

  const hasCoordinates = customer.latitude !== "" && customer.latitude != null && customer.longitude !== "" && customer.longitude != null;
  const latitude = Number(customer.latitude);
  const longitude = Number(customer.longitude);
  const hasLocation = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  const accuracy = Number(customer.locationAccuracy);
  return {
    customer: {
      name,
      email,
      phone,
      address,
      location: hasCoordinates && hasLocation ? { latitude, longitude, accuracy: Number.isFinite(accuracy) && accuracy > 0 ? Math.min(Math.round(accuracy), 100000) : null } : null,
    },
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    hasUnpricedItems,
  };
}

async function listOrders(env) {
  let cursor;
  let keys = [];
  do {
    const page = await env.SHOP_DATA.list({ prefix: "order:", limit: 1000, cursor });
    keys = keys.concat(page.keys.map((key) => key.name)).slice(-200);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const orders = (await Promise.all(keys.map((key) => env.SHOP_DATA.get(key, "json"))))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ orders });
}

async function updateOrderStatus(env, id, request) {
  if (!/^\d{17}-[a-f0-9-]{36}$/i.test(id)) return json({ error: "Order not found." }, 404);
  const key = "order:" + id;
  const order = await env.SHOP_DATA.get(key, "json");
  if (!order) return json({ error: "Order not found." }, 404);
  const body = await readJson(request, 8192);
  if (!body || !ORDER_STATUSES.includes(body.status)) return json({ error: "Choose a valid order status." }, 400);

  const changed = order.status !== body.status;
  order.status = body.status;
  order.updatedAt = new Date().toISOString();
  await env.SHOP_DATA.put(key, JSON.stringify(order), {
    metadata: { createdAt: order.createdAt, status: order.status },
  });
  const emailSent = changed ? await sendOrderEmail(env, order, order.status) : null;
  return json({ ok: true, order, emailSent });
}

async function sendOrderEmail(env, order, status) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM) return false;
  const label = ORDER_STATUS_LABELS[status];
  const currency = order.currency || { code: "INR", locale: "en-IN" };
  let subtotal;
  try {
    subtotal = new Intl.NumberFormat(currency.locale, { style: "currency", currency: currency.code }).format(order.subtotal);
  } catch {
    subtotal = String(order.subtotal);
  }
  const itemLines = order.items.map((item) => `${item.quantity} x ${item.name}${item.unit ? ` (${item.unit})` : ""}`).join("\n");
  const textBody = [
    `Hello ${order.customer.name},`,
    "",
    `Your HP Fresh Fruits order ${order.id} status is: ${label}.`,
    "",
    "Order items:",
    itemLines,
    order.hasUnpricedItems ? `Priced items subtotal: ${subtotal}; some items are price on request.` : `Subtotal: ${subtotal}`,
    "",
    "We will email you when your order status changes.",
  ].join("\n");
  return sendEmail(env, order.customer.email, `${label} - HP Fresh Fruits order ${order.id}`, textBody);
}

async function sendEmail(env, to, subject, textBody) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.ORDER_EMAIL_FROM, to: [to], subject, text: textBody }),
    });
    if (!response.ok) {
      console.error("Email provider returned", response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Email could not be sent", err);
    return false;
  }
}

/* ---------- Customer accounts ---------- */
//
// KV keys:
//   customer:<email>         the account (metadata: name, createdAt for reports)
//   customer-orders:<id>     the account's order ids, newest last
//   session:<sha256(token)>  a signed-in browser; the token itself is only in the cookie
//   reset:<sha256(token)>    a password reset link, valid for an hour
//
// Bumping an account's sessionVersion signs out every browser and voids
// outstanding reset links (done on password reset).

async function account(request, env, url, route) {
  const method = request.method;
  if (route === "auth/register" && method === "POST") return register(request, env, url);
  if (route === "auth/login" && method === "POST") return customerLogin(request, env, url);
  if (route === "auth/logout" && method === "POST") return customerLogout(request, env, url);
  if (route === "auth/forgot" && method === "POST") return forgotPassword(request, env, url);
  if (route === "auth/reset" && method === "POST") return resetPassword(request, env, url);

  const session = await currentCustomer(request, env);
  if (route === "account" && method === "GET") return json({ customer: session ? publicCustomer(session.customer) : null });
  if (!session) return json({ error: "Please sign in." }, 401);
  if (route === "account/orders" && method === "GET") return customerOrders(env, session.customer);
  return json({ error: "Not found" }, 404);
}

async function register(request, env, url) {
  if (await throttle(env, "register", clientIp(request), 5, 3600)) {
    return json({ error: "Too many sign-up attempts. Please try again later." }, 429);
  }
  const body = (await readJson(request, 8192)) || {};
  const name = text(body.name, 100);
  const email = normalEmail(body.email);
  const phone = text(body.phone, 40);
  const password = String(body.password || "");
  if (!name || !email) return json({ error: "Enter your name and a valid email address." }, 400);
  const weak = passwordProblem(password);
  if (weak) return json({ error: weak }, 400);
  if (await env.SHOP_DATA.get("customer:" + email)) {
    return json({ error: "An account with this email already exists. Please sign in instead." }, 409);
  }
  const customer = {
    id: crypto.randomUUID(),
    email,
    name,
    phone,
    address: "",
    passwordHash: await hashPassword(password),
    sessionVersion: 1,
    createdAt: new Date().toISOString(),
  };
  await saveCustomer(env, customer);
  return signedIn(env, url, customer, 201);
}

async function customerLogin(request, env, url) {
  const ip = clientIp(request);
  const body = (await readJson(request, 8192)) || {};
  const email = normalEmail(body.email);
  const password = String(body.password || "");
  // Failed attempts are limited per connection and per account.
  if (await isLimited(env, "login-ip", ip, 20, 900) || (email && await isLimited(env, "login-email", email, 10, 900))) {
    return json({ error: "Too many sign-in attempts. Please wait 15 minutes or reset your password." }, 429);
  }
  const customer = email ? await env.SHOP_DATA.get("customer:" + email, "json") : null;
  // Hash even when there is no account, so timing doesn't reveal which emails exist.
  const ok = customer ? await verifyPassword(password, customer.passwordHash) : (await hashPassword(password), false);
  if (!ok) {
    await countAttempt(env, "login-ip", ip, 900);
    if (email) await countAttempt(env, "login-email", email, 900);
    return json({ error: "Wrong email or password." }, 401);
  }
  return signedIn(env, url, customer);
}

async function customerLogout(request, env, url) {
  const token = sessionToken(request);
  if (token) await env.SHOP_DATA.delete("session:" + (await sha256(token)));
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0, url) });
}

async function forgotPassword(request, env, url) {
  const body = (await readJson(request, 8192)) || {};
  const email = normalEmail(body.email);
  const done = json({ ok: true, message: "If an account uses that email, we've sent a link to reset the password. It works for one hour." });
  if (!email) return json({ error: "Enter a valid email address." }, 400);
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM) {
    return json({ error: "Password reset by email isn't available yet. Please contact us and we'll help you." }, 503);
  }
  if (await throttle(env, "forgot-ip", clientIp(request), 5, 3600) || await throttle(env, "forgot-email", email, 3, 3600)) return done;
  const customer = await env.SHOP_DATA.get("customer:" + email, "json");
  if (!customer) return done;
  const token = randomToken();
  await env.SHOP_DATA.put("reset:" + (await sha256(token)), JSON.stringify({ email, version: customer.sessionVersion }), { expirationTtl: 3600 });
  // The token goes in the #fragment, so it never reaches server logs or Referer headers.
  const link = `${url.origin}/#reset=${token}`;
  await sendEmail(env, email, "Reset your HP Fresh Fruits password", [
    `Hello ${customer.name},`,
    "",
    "Someone asked to reset the password for your HP Fresh Fruits account.",
    "Open this link within one hour to choose a new password:",
    link,
    "",
    "If this wasn't you, ignore this email; your password stays the same.",
  ].join("\n"));
  return done;
}

async function resetPassword(request, env, url) {
  if (await throttle(env, "reset-ip", clientIp(request), 10, 3600)) {
    return json({ error: "Too many attempts. Please try again later." }, 429);
  }
  const body = (await readJson(request, 8192)) || {};
  const token = String(body.token || "");
  const password = String(body.password || "");
  const invalid = json({ error: "This reset link is invalid or has expired. Please request a new one." }, 400);
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return invalid;
  const weak = passwordProblem(password);
  if (weak) return json({ error: weak }, 400);
  const key = "reset:" + (await sha256(token));
  const reset = await env.SHOP_DATA.get(key, "json");
  if (!reset) return invalid;
  await env.SHOP_DATA.delete(key);
  const customer = await env.SHOP_DATA.get("customer:" + reset.email, "json");
  if (!customer || customer.sessionVersion !== reset.version) return invalid;
  customer.passwordHash = await hashPassword(password);
  customer.sessionVersion += 1; // signs out every other browser
  await saveCustomer(env, customer);
  return signedIn(env, url, customer);
}

async function customerOrders(env, customer) {
  const ids = (await env.SHOP_DATA.get("customer-orders:" + customer.id, "json")) || [];
  const orders = (await Promise.all(ids.slice(-50).reverse().map((id) => env.SHOP_DATA.get("order:" + id, "json"))))
    .filter((order) => order && order.customerId === customer.id)
    .map((order) => ({
      id: order.id,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      status: order.status,
      items: order.items,
      subtotal: order.subtotal,
      hasUnpricedItems: order.hasUnpricedItems,
      currency: order.currency,
    }));
  return json({ orders });
}

async function linkOrderToCustomer(env, customer, order) {
  const key = "customer-orders:" + customer.id;
  const ids = (await env.SHOP_DATA.get(key, "json")) || [];
  ids.push(order.id);
  await env.SHOP_DATA.put(key, JSON.stringify(ids.slice(-200)));
  // Remember the latest delivery details to fill in next time.
  if (customer.phone !== order.customer.phone || customer.address !== order.customer.address) {
    customer.phone = order.customer.phone;
    customer.address = order.customer.address;
    await saveCustomer(env, customer);
  }
}

async function signedIn(env, url, customer, status = 200) {
  const token = randomToken();
  await env.SHOP_DATA.put("session:" + (await sha256(token)), JSON.stringify({ email: customer.email, version: customer.sessionVersion }), {
    expirationTtl: SESSION_DAYS * 86400,
  });
  return json({ ok: true, customer: publicCustomer(customer) }, status, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400, url) });
}

async function currentCustomer(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  const session = await env.SHOP_DATA.get("session:" + (await sha256(token)), "json");
  if (!session) return null;
  const customer = await env.SHOP_DATA.get("customer:" + session.email, "json");
  if (!customer || customer.sessionVersion !== session.version) return null;
  return { customer };
}

function sessionToken(request) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{32})(?:;|$)`));
  return match ? match[1] : "";
}

function sessionCookie(value, maxAge, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  // Only the API needs the cookie; JavaScript can't read it.
  return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function saveCustomer(env, customer) {
  return env.SHOP_DATA.put("customer:" + customer.email, JSON.stringify(customer), {
    metadata: { name: customer.name.slice(0, 100), createdAt: customer.createdAt },
  });
}

function publicCustomer(customer) {
  return { name: customer.name, email: customer.email, phone: customer.phone || "", address: customer.address || "" };
}

function normalEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : "";
}

function passwordProblem(password) {
  if (password.length < 8) return "Use a password of at least 8 characters.";
  if (password.length > 200) return "That password is too long (200 characters max).";
  return "";
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(bits)}`;
}

async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored || "").split("$");
  if (scheme !== "pbkdf2-sha256" || !salt || !expected) return false;
  const actual = await hashPassword(password, decodeBase64url(salt), Number(iterations));
  return safeEqual(actual.split("$")[3], expected);
}

/* ---------- Rate limiting ---------- */
//
// Fixed-window counters in KV. KV is eventually consistent, so limits are
// approximate under bursts, but they stop sustained guessing and spam.
// Identifiers are hashed so raw IPs and emails aren't stored.

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function throttleKey(bucket, id, windowSeconds) {
  return `throttle:${bucket}:${(await sha256(id)).slice(0, 22)}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
}

async function isLimited(env, bucket, id, limit, windowSeconds) {
  return (Number(await env.SHOP_DATA.get(await throttleKey(bucket, id, windowSeconds))) || 0) >= limit;
}

async function countAttempt(env, bucket, id, windowSeconds) {
  const key = await throttleKey(bucket, id, windowSeconds);
  const used = Number(await env.SHOP_DATA.get(key)) || 0;
  await env.SHOP_DATA.put(key, String(used + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
}

// Counts this attempt; true when the limit was already reached.
async function throttle(env, bucket, id, limit, windowSeconds) {
  if (await isLimited(env, bucket, id, limit, windowSeconds)) return true;
  await countAttempt(env, bucket, id, windowSeconds);
  return false;
}

async function servePhoto(env, name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,120}$/.test(name)) return json({ error: "Not found" }, 404);
  const { value, metadata } = await env.SHOP_DATA.getWithMetadata("photo:" + name, "arrayBuffer");
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: {
      "Content-Type": (metadata && metadata.contentType) || "application/octet-stream",
      // Photo names are unique per upload, so they never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      // If a browser ever renders the file as a page, nothing in it can run.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

// The image type from the file's first bytes; the browser's claim isn't trusted.
function sniffImage(buffer) {
  const b = new Uint8Array(buffer.slice(0, 16));
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  return "";
}

/* ---------- Reports ---------- */

// Raw data for the admin backend's monthly Excel report: orders placed in
// [from, to), the catalogue, and every account's name and sign-up date.
async function reportData(env, url) {
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to || to - from > 32 * 86400000) {
    return json({ error: "Choose a valid month." }, 400);
  }
  // Order keys begin with their UTC creation time (YYYYMMDDhhmmssSSS), so
  // list the UTC months the range touches and filter on the key alone.
  const keys = [];
  const first = new Date(from);
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); Date.UTC(y, m, 1) < to; m === 11 ? (y++, m = 0) : m++) {
    let cursor;
    do {
      const page = await env.SHOP_DATA.list({ prefix: `order:${y}${String(m + 1).padStart(2, "0")}`, limit: 1000, cursor });
      for (const { name } of page.keys) {
        const t = orderKeyTime(name);
        if (t >= from && t < to) keys.push(name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  const truncated = keys.length > MAX_REPORT_ORDERS;
  const orders = [];
  const wanted = keys.slice(0, MAX_REPORT_ORDERS);
  for (let i = 0; i < wanted.length; i += 50) {
    const batch = await Promise.all(wanted.slice(i, i + 50).map((key) => env.SHOP_DATA.get(key, "json")));
    orders.push(...batch.filter(Boolean));
  }

  const customers = [];
  let cursor;
  do {
    const page = await env.SHOP_DATA.list({ prefix: "customer:", limit: 1000, cursor });
    for (const key of page.keys) {
      customers.push({ email: key.name.slice(9), name: (key.metadata && key.metadata.name) || "", createdAt: (key.metadata && key.metadata.createdAt) || "" });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const [settings, products] = await Promise.all([loadDoc(env, "settings"), loadDoc(env, "products")]);
  return json({ orders, truncated, totalOrders: keys.length, customers, settings, products });
}

function orderKeyTime(key) {
  const d = /^order:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})-/.exec(key);
  return d ? Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6], +d[7]) : NaN;
}

/* ---------- Private (admin backend only) ---------- */

async function internal(request, env, route) {
  if (!(await isInternalCaller(request, env))) return json({ error: "Forbidden" }, 403);
  const method = request.method;

  if (route === "catalog" && method === "GET") {
    const [settings, products] = await Promise.all([loadDoc(env, "settings"), loadDoc(env, "products")]);
    return json({ settings, products });
  }
  if (route === "orders" && method === "GET") return listOrders(env);
  if (route === "report" && method === "GET") return reportData(env, new URL(request.url));
  if (route === "throttle" && method === "POST") {
    // { bucket, id, limit, window, count }: is this caller over the limit?
    // With count, records one attempt. Used for admin sign-in, which has no storage.
    const body = (await readJson(request, 4096)) || {};
    const bucket = String(body.bucket || "");
    const limit = Number(body.limit), windowSeconds = Number(body.window);
    if (!/^admin-[a-z-]{1,30}$/.test(bucket) || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400) {
      return json({ error: "Invalid throttle request." }, 400);
    }
    const id = String(body.id || "").slice(0, 300);
    if (body.count) await countAttempt(env, bucket, id, windowSeconds);
    return json({ limited: await isLimited(env, bucket, id, limit, windowSeconds) });
  }
  if (route.startsWith("orders/") && method === "PUT") return updateOrderStatus(env, route.slice(7), request);
  if (route === "products" && method === "PUT") {
    const body = await readJson(request, MAX_JSON_BYTES);
    const result = cleanProducts(body && body.products);
    if (result.error) return json({ error: result.error }, 400);
    await env.SHOP_DATA.put("catalog:products", JSON.stringify(result.products));
    return json({ ok: true, products: result.products });
  }
  if (route === "settings" && method === "PUT") {
    const body = await readJson(request, MAX_JSON_BYTES);
    const result = cleanSettings(body && body.settings);
    if (result.error) return json({ error: result.error }, 400);
    await env.SHOP_DATA.put("catalog:settings", JSON.stringify(result.settings));
    return json({ ok: true, settings: result.settings });
  }
  if (route === "photos" && method === "POST") {
    const data = await readBoundedBody(request, MAX_PHOTO_BYTES);
    if (!data.byteLength) return json({ error: "The photo is empty." }, 400);
    if (data.byteLength > MAX_PHOTO_BYTES) return json({ error: "Photos must be 5 MB or smaller." }, 413);
    const type = sniffImage(data);
    const ext = PHOTO_TYPES[type];
    if (!ext) return json({ error: "Photos must be JPG, PNG, WebP, GIF or AVIF." }, 415);
    const base = slug(new URL(request.url).searchParams.get("name") || "photo").slice(0, 60) || "photo";
    const name = `${Date.now().toString(36)}-${base}.${ext}`;
    await env.SHOP_DATA.put("photo:" + name, data, { metadata: { contentType: type } });
    return json({ ok: true, path: "photos/" + name }, 201);
  }
  if (route.startsWith("photos/") && method === "DELETE") {
    const name = route.slice(7);
    if (!/^[a-z0-9][a-z0-9._-]{0,120}$/.test(name)) return json({ error: "Not found" }, 404);
    await env.SHOP_DATA.delete("photo:" + name);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

async function isInternalCaller(request, env) {
  const expected = env.INTERNAL_API_KEY || "";
  const given = request.headers.get("X-Internal-Key") || "";
  // Refuse everything until a proper key is configured.
  if (expected.length < 16) return false;
  return safeEqual(given, expected);
}

/* ---------- Storage ---------- */

async function loadDoc(env, name) {
  const saved = await env.SHOP_DATA.get("catalog:" + name, "json");
  if (saved) return saved;
  // First run: fall back to the catalogue bundled with the website.
  const res = await env.ASSETS.fetch(new Request(`https://assets.local/data/${name}.json`));
  if (!res.ok) throw new Error(`Missing bundled data/${name}.json`);
  const doc = await res.json();
  return name === "products" ? doc.products || [] : doc;
}

/* ---------- Validation ---------- */

function cleanProducts(list) {
  if (!Array.isArray(list)) return { error: "Expected a list of products." };
  if (list.length > 500) return { error: "Too many products (500 max)." };
  const seen = new Set();
  const products = [];
  for (const [i, p] of list.entries()) {
    if (!p || typeof p !== "object") return { error: `Product ${i + 1} is not valid.` };
    const name = text(p.name, 100);
    if (!name) return { error: `Product ${i + 1} needs a name.` };
    const id = slug(p.id || name);
    if (!id) return { error: `"${name}" needs a product code.` };
    if (seen.has(id)) return { error: `Two products use the code "${id}". Codes must be unique.` };
    seen.add(id);
    // An empty price means "price on request".
    const onRequest = p.price === null || p.price === undefined || p.price === "";
    const price = Number(p.price);
    if (!onRequest && (!Number.isFinite(price) || price < 0 || price > 10000000)) return { error: `"${name}" has an invalid price.` };
    products.push({
      id,
      name,
      visible: p.visible !== false,
      stock: STOCK.includes(p.stock) ? p.stock : "in_stock",
      featured: p.featured === true,
      category: text(p.category, 40) || "Other",
      origin: text(p.origin, 60),
      price: onRequest ? null : Math.round(price * 100) / 100,
      unit: text(p.unit, 40),
      description: text(p.description, 600),
      photo: photoPath(p.photo),
      photoCreditTitle: text(p.photoCreditTitle, 200),
      photoCreditUrl: httpUrl(p.photoCreditUrl),
      emoji: text(p.emoji, 8),
      illustration: /^images\/[a-z0-9._/-]+\.svg$/i.test(p.illustration || "") ? p.illustration : "",
      tint: /^#[0-9a-f]{3,8}$/i.test(p.tint || "") ? p.tint : "",
    });
  }
  return { products };
}

function cleanSettings(s) {
  if (!s || typeof s !== "object") return { error: "Expected shop settings." };
  const b = s.brand || {}, h = s.hero || {}, o = s.orders || {}, m = s.minOrder || {}, c = s.currency || {};
  const moq = parseInt(m.value, 10);
  const settings = {
    brand: { name: text(b.name, 80) || "Fruit Shop", tagline: text(b.tagline, 160), email: text(b.email, 120), phone: text(b.phone, 40), address: text(b.address, 200) },
    hero: { eyebrow: text(h.eyebrow, 120), title: text(h.title, 120), titleHighlight: text(h.titleHighlight, 120) },
    orders: { whatsappNumber: String(o.whatsappNumber || "").replace(/\D/g, "").slice(0, 15), deliveryNote: text(o.deliveryNote, 200) },
    minOrder: { value: moq > 0 ? moq : null, unit: m.unit === "amount" ? "amount" : "items", pendingMessage: text(m.pendingMessage, 200) },
    currency: { code: /^[A-Z]{3}$/.test(c.code || "") ? c.code : "INR", locale: /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(c.locale || "") ? c.locale : "en-IN" },
  };
  return { settings };
}

function text(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function slug(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// Photos are either bundled with the shop (images/...), uploaded (photos/...)
// or an https:// address.
function photoPath(value) {
  const v = String(value || "").trim();
  if (/^(images|photos)\/[a-z0-9._/-]+$/i.test(v) && !v.includes("..")) return v;
  return httpUrl(v);
}

function httpUrl(value) {
  const v = String(value || "").trim();
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

/* ---------- Helpers ---------- */

async function readJson(request, maxBytes) {
  try {
    const data = await readBoundedBody(request, maxBytes);
    return JSON.parse(new TextDecoder().decode(data));
  } catch (err) {
    if (err.status === 413) throw err;
    return null;
  }
}

async function readBoundedBody(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw Object.assign(new Error("Body too large"), { status: 413 });
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error("Body too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin",
      ...headers,
    },
  });
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

async function sha256(value) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function base64url(buffer) {
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// Constant-time string comparison, so the key can't be guessed from timing.
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
