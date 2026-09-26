// Storefront backend (Cloudflare Worker).
//
// Public, called by the shop's pages:
//   GET  /api/catalog          shop settings + visible products
//   GET  /photos/<name>        a photo uploaded through the admin panel
//
// Private, called only by the admin backend (header X-Internal-Key):
//   GET    /internal/catalog   settings + all products, hidden ones included
//   PUT    /internal/products  replace the product list
//   PUT    /internal/settings  replace the shop settings
//   POST   /internal/photos    upload a photo (raw image body)
//   DELETE /internal/photos/<name>
//
// Everything else is a static file from ../shop.
//
// Data lives in the SHOP_DATA KV namespace. Until the admin panel saves for
// the first time, the catalogue comes from the bundled shop/data/*.json files.

const STOCK = ["in_stock", "limited", "new", "sold_out"];
const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/api/catalog" && request.method === "GET") return await publicCatalog(env);
      if (pathname.startsWith("/photos/") && request.method === "GET") return await servePhoto(env, pathname.slice(8));
      if (pathname.startsWith("/internal/")) return await internal(request, env, pathname.slice(10));
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
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
    },
  });
}

/* ---------- Private (admin backend only) ---------- */

async function internal(request, env, route) {
  if (!(await isInternalCaller(request, env))) return json({ error: "Forbidden" }, 403);
  const method = request.method;

  if (route === "catalog" && method === "GET") {
    const [settings, products] = await Promise.all([loadDoc(env, "settings"), loadDoc(env, "products")]);
    return json({ settings, products });
  }
  if (route === "products" && method === "PUT") {
    const body = await readJson(request);
    const result = cleanProducts(body && body.products);
    if (result.error) return json({ error: result.error }, 400);
    await env.SHOP_DATA.put("catalog:products", JSON.stringify(result.products));
    return json({ ok: true, products: result.products });
  }
  if (route === "settings" && method === "PUT") {
    const body = await readJson(request);
    const result = cleanSettings(body && body.settings);
    if (result.error) return json({ error: result.error }, 400);
    await env.SHOP_DATA.put("catalog:settings", JSON.stringify(result.settings));
    return json({ ok: true, settings: result.settings });
  }
  if (route === "photos" && method === "POST") {
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    const ext = PHOTO_TYPES[type];
    if (!ext) return json({ error: "Photos must be JPG, PNG, WebP, GIF or AVIF." }, 415);
    const data = await request.arrayBuffer();
    if (!data.byteLength) return json({ error: "The photo is empty." }, 400);
    if (data.byteLength > MAX_PHOTO_BYTES) return json({ error: "Photos must be 5 MB or smaller." }, 413);
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
  // First run: fall back to the catalogue bundled with the shop's files.
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
    const price = Number(p.price);
    if (!Number.isFinite(price) || price < 0 || price > 10000000) return { error: `"${name}" has an invalid price.` };
    products.push({
      id,
      name,
      visible: p.visible !== false,
      stock: STOCK.includes(p.stock) ? p.stock : "in_stock",
      featured: p.featured === true,
      category: text(p.category, 40) || "Other",
      origin: text(p.origin, 60),
      price: Math.round(price * 100) / 100,
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
    brand: { name: text(b.name, 80) || "Fruit Shop", tagline: text(b.tagline, 160), email: text(b.email, 120), phone: text(b.phone, 40) },
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

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// Constant-time string comparison, so the key can't be guessed from timing.
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
