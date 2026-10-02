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
//   GET  /api/reports/monthly?month=YYYY-MM&tz=Area/City
//                             monthly sales report (.xlsx) (login required)
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
    if (origin !== url.origin) return json({ error: "Forbidden" }, 403);
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
  if (route === "orders" && method === "GET") return shop(env, "GET", "orders");
  if (route === "reports/monthly" && method === "GET") return monthlyReport(env, url);
  if (route.startsWith("orders/") && method === "PUT") {
    const id = route.slice(7);
    if (!/^\d{17}-[a-f0-9-]{36}$/i.test(id)) return json({ error: "Order not found." }, 404);
    return shop(env, "PUT", "orders/" + encodeURIComponent(id), await body(request), "application/json");
  }
  if (route === "products" && method === "PUT") return shop(env, "PUT", "products", await body(request), "application/json");
  if (route === "settings" && method === "PUT") return shop(env, "PUT", "settings", await body(request), "application/json");
  if (route === "photos" && method === "POST") {
    const name = encodeURIComponent(url.searchParams.get("name") || "photo");
    return shop(env, "POST", "photos?name=" + name, await body(request), request.headers.get("Content-Type") || "");
  }
  return json({ error: "Not found" }, 404);
}

/* ---------- Talking to the storefront backend ---------- */

function shopRequest(env, method, route, payload, contentType) {
  const headers = { "X-Internal-Key": env.INTERNAL_API_KEY };
  if (contentType) headers["Content-Type"] = contentType;
  const req = new Request("https://shop.internal/internal/" + route, { method, headers, body: payload });
  // Normally a service binding; SHOP_API_URL is a fallback for setups without one.
  return env.SHOP_API ? env.SHOP_API.fetch(req) : fetch(new Request(new URL("/internal/" + route, env.SHOP_API_URL), req));
}

async function shop(env, method, route, payload, contentType) {
  if (!env.INTERNAL_API_KEY) return json({ error: "Admin setup incomplete. Add INTERNAL_API_KEY under Settings → Variables and Secrets on this Worker." }, 500);
  let res;
  try {
    res = await shopRequest(env, method, route, payload, contentType);
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
  return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") || "", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
}

/* ---------- Monthly report (Excel) ---------- */

const STATUS_LABELS = {
  received: "Order received",
  confirmed: "Confirmed",
  preparing: "Preparing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const STOCK_LABELS = { in_stock: "In stock", limited: "Limited stock", new: "New arrival", sold_out: "Sold out" };

async function monthlyReport(env, url) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(url.searchParams.get("month") || "");
  if (!m) return json({ error: "Choose a month." }, 400);
  const year = Number(m[1]), month = Number(m[2]);
  // Month boundaries and dates follow the admin's own time zone.
  const timeZone = validTimeZone(url.searchParams.get("tz"));
  const from = zonedMonthStart(year, month, timeZone);
  const to = zonedMonthStart(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, timeZone);
  const res = await shop(env, "GET", `report?from=${from}&to=${to}`);
  if (!res.ok) return res;
  const data = await res.json();
  const file = xlsx(reportSheets(data, { year, month, timeZone, from, to }));
  return new Response(file, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="hp-fresh-fruits-report-${m[0]}.xlsx"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Cancelled orders are listed but left out of every sales figure. Items
// without a price ("price on request") count as units but add nothing to sales.
function reportSheets(data, { year, month, timeZone, from, to }) {
  const settings = data.settings || {};
  const code = (settings.currency && settings.currency.code) || "INR";
  const brand = (settings.brand && settings.brand.name) || "HP Fresh Fruits";
  const monthName = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, 1));
  const catalogue = new Map((data.products || []).map((p) => [p.id, p]));
  const orders = (data.orders || []).filter((o) => o && o.id && Array.isArray(o.items)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sold = orders.filter((o) => o.status !== "cancelled");
  const at = (iso) => ({ v: localSerial(Date.parse(iso), timeZone), type: "datetime" });
  const orderNo = (o) => o.id.slice(-8).toUpperCase();
  const units = (o) => o.items.reduce((n, i) => n + i.quantity, 0);
  const total = (list, fn) => round2(list.reduce((n, x) => n + fn(x), 0));
  const yesNo = (v) => (v ? "Yes" : "No");
  const salesTotal = total(sold, (o) => o.subtotal || 0);

  // Per product
  const byProduct = new Map();
  for (const o of sold) {
    for (const i of o.items) {
      const r = byProduct.get(i.id) || { id: i.id, name: i.name, units: 0, orders: 0, sales: 0, onRequest: 0 };
      r.units += i.quantity;
      r.orders += 1;
      if (i.price === null) r.onRequest += i.quantity;
      else r.sales += i.price * i.quantity;
      byProduct.set(i.id, r);
    }
  }

  // Per day, including days without orders
  const days = new Map();
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= dayCount; d++) days.set(`${year}-${pad2(month)}-${pad2(d)}`, { orders: 0, cancelled: 0, units: 0, sales: 0 });
  for (const o of orders) {
    const r = days.get(localDay(Date.parse(o.createdAt), timeZone));
    if (!r) continue;
    if (o.status === "cancelled") r.cancelled++;
    else {
      r.orders++;
      r.units += units(o);
      r.sales += o.subtotal || 0;
    }
  }

  // Per customer (by email)
  const byCustomer = new Map();
  for (const o of sold) {
    const c = o.customer || {};
    const key = String(c.email || "").toLowerCase();
    const r = byCustomer.get(key) || { orders: 0, units: 0, sales: 0, first: o.createdAt, registered: false };
    Object.assign(r, { name: c.name, email: c.email, phone: c.phone, last: o.createdAt });
    r.orders++;
    r.units += units(o);
    r.sales += o.subtotal || 0;
    r.registered = r.registered || !!o.customerId;
    byCustomer.set(key, r);
  }

  const newCustomers = (data.customers || [])
    .filter((c) => { const t = Date.parse(c.createdAt); return t >= from && t < to; })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const bold = (v) => ({ v, type: "bold" });
  const money = (v) => ({ v: round2(v), type: "money" });
  const statusRows = Object.entries(STATUS_LABELS).map(([status, label]) => {
    const list = orders.filter((o) => o.status === status);
    return [label, list.length, money(total(list, (o) => o.subtotal || 0))];
  });
  const summary = [
    [{ v: `${brand}: sales report`, type: "title" }],
    ["Month", monthName],
    ["Time zone", timeZone],
    ["Generated", { v: localSerial(Date.now(), timeZone), type: "datetime" }],
    ["Currency", code],
    [],
    [bold("Sales (excluding cancelled orders)")],
    ["Orders", sold.length],
    [`Sales (${code})`, money(salesTotal)],
    [`Average order value (${code})`, money(sold.length ? salesTotal / sold.length : 0)],
    ["Units sold", total(sold, units)],
    ["Delivered orders", orders.filter((o) => o.status === "delivered").length],
    [`Delivered sales (${code})`, money(total(orders.filter((o) => o.status === "delivered"), (o) => o.subtotal || 0))],
    ["Orders with price-on-request items", sold.filter((o) => o.hasUnpricedItems).length],
    ["Customers who ordered", byCustomer.size],
    ["Orders from registered accounts", sold.filter((o) => o.customerId).length],
    [],
    [bold("All orders placed"), bold("Orders"), bold(`Value (${code})`)],
    ...statusRows,
    ["Total", orders.length, money(total(orders, (o) => o.subtotal || 0))],
    [],
    [bold("Customer accounts")],
    ["New accounts this month", newCustomers.length],
    ["All accounts", (data.customers || []).length],
    [],
    ["Notes", "Sales figures leave out cancelled orders. Items marked 'price on request' count as units but not as sales."],
  ];
  if (data.truncated) {
    summary.push(["Warning", `This month has ${data.totalOrders} orders; only the first ${orders.length} are included.`]);
  }

  return [
    { name: "Summary", header: false, columns: [{ width: 38 }, { width: 26 }, { width: 18 }], rows: summary },
    {
      name: "Orders",
      columns: [
        { header: "Order no.", width: 12 }, { header: "Placed", width: 17, type: "datetime" }, { header: "Status", width: 17 },
        { header: "Customer", width: 22 }, { header: "Email", width: 28 }, { header: "Phone", width: 16 }, { header: "Address", width: 40 },
        { header: "Map link", width: 24 }, { header: "Products", width: 10, type: "int" }, { header: "Units", width: 8, type: "int" },
        { header: `Subtotal (${code})`, width: 15, type: "money" }, { header: "Price on request items", width: 12 },
        { header: "Account", width: 12 }, { header: "Last updated", width: 17, type: "datetime" }, { header: "Order ID", width: 56 },
      ],
      rows: orders.map((o) => {
        const c = o.customer || {};
        const loc = c.location;
        return [
          orderNo(o), at(o.createdAt), STATUS_LABELS[o.status] || o.status, c.name, c.email, c.phone, c.address,
          loc ? `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}` : "",
          o.items.length, units(o), o.subtotal || 0, yesNo(o.hasUnpricedItems), o.customerId ? "Registered" : "Guest",
          at(o.updatedAt || o.createdAt), o.id,
        ];
      }),
    },
    {
      name: "Order lines",
      columns: [
        { header: "Order no.", width: 12 }, { header: "Placed", width: 17, type: "datetime" }, { header: "Status", width: 17 },
        { header: "Product code", width: 22 }, { header: "Product", width: 26 }, { header: "Pack / unit", width: 14 },
        { header: "Quantity", width: 10, type: "int" }, { header: `Unit price (${code})`, width: 15, type: "money" },
        { header: `Line total (${code})`, width: 15, type: "money" },
      ],
      rows: orders.flatMap((o) => o.items.map((i) => [
        orderNo(o), at(o.createdAt), STATUS_LABELS[o.status] || o.status, i.id, i.name, i.unit, i.quantity,
        i.price === null ? "On request" : i.price, i.price === null ? null : round2(i.price * i.quantity),
      ])),
    },
    {
      name: "Product sales",
      columns: [
        { header: "Product code", width: 22 }, { header: "Product", width: 26 }, { header: "Category", width: 16 },
        { header: "Origin", width: 16 }, { header: "Units sold", width: 11, type: "int" }, { header: "Orders", width: 9, type: "int" },
        { header: `Sales (${code})`, width: 15, type: "money" }, { header: "Share of sales", width: 13, type: "percent" },
        { header: "Units on request", width: 13, type: "int" },
      ],
      rows: [...byProduct.values()]
        .sort((a, b) => b.sales - a.sales || b.units - a.units)
        .map((r) => {
          const p = catalogue.get(r.id) || {};
          return [r.id, r.name, p.category || "", p.origin || "", r.units, r.orders, round2(r.sales), salesTotal ? r.sales / salesTotal : 0, r.onRequest];
        }),
    },
    {
      name: "Daily sales",
      columns: [
        { header: "Date", width: 12, type: "date" }, { header: "Orders", width: 9, type: "int" }, { header: "Cancelled", width: 10, type: "int" },
        { header: "Units", width: 9, type: "int" }, { header: `Sales (${code})`, width: 15, type: "money" },
      ],
      rows: [
        ...[...days].map(([day, r]) => [{ v: dateSerial(day), type: "date" }, r.orders, r.cancelled, r.units, round2(r.sales)]),
        [bold("Total"), sold.length, orders.length - sold.length, total(sold, units), money(salesTotal)],
      ],
    },
    {
      name: "Customers",
      columns: [
        { header: "Customer", width: 22 }, { header: "Email", width: 28 }, { header: "Phone", width: 16 },
        { header: "Orders", width: 9, type: "int" }, { header: "Units", width: 9, type: "int" }, { header: `Sales (${code})`, width: 15, type: "money" },
        { header: "First order", width: 17, type: "datetime" }, { header: "Last order", width: 17, type: "datetime" }, { header: "Account", width: 12 },
      ],
      rows: [...byCustomer.values()]
        .sort((a, b) => b.sales - a.sales || b.orders - a.orders)
        .map((r) => [r.name, r.email, r.phone, r.orders, r.units, round2(r.sales), at(r.first), at(r.last), r.registered ? "Registered" : "Guest"]),
    },
    {
      name: "New accounts",
      columns: [{ header: "Name", width: 24 }, { header: "Email", width: 30 }, { header: "Joined", width: 17, type: "datetime" }],
      rows: newCustomers.map((c) => [c.name, c.email, at(c.createdAt)]),
    },
    {
      name: "Catalogue",
      columns: [
        { header: "Product code", width: 22 }, { header: "Product", width: 26 }, { header: "Category", width: 16 }, { header: "Origin", width: 16 },
        { header: `Price (${code})`, width: 13, type: "money" }, { header: "Pack / unit", width: 14 }, { header: "Stock", width: 14 },
        { header: "On website", width: 11 }, { header: "In slider", width: 10 },
      ],
      rows: (data.products || []).map((p) => [
        p.id, p.name, p.category, p.origin, p.price === null || p.price === undefined ? "On request" : p.price, p.unit,
        STOCK_LABELS[p.stock] || "In stock", yesNo(p.visible !== false), yesNo(p.featured),
      ]),
    },
  ];
}

function validTimeZone(value) {
  const tz = String(value || "");
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const zoneFormats = new Map();
// Milliseconds the zone's wall clock is ahead of UTC at instant t.
function zoneOffset(t, timeZone) {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    zoneFormats.set(timeZone, format);
  }
  const p = {};
  for (const part of format.formatToParts(new Date(t))) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - (t - (((t % 1000) + 1000) % 1000));
}

// The UTC instant of local midnight on the 1st of the month.
function zonedMonthStart(year, month, timeZone) {
  const wall = Date.UTC(year, month - 1, 1);
  const guess = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(guess, timeZone);
}

function localDay(t, timeZone) {
  return new Date(t + zoneOffset(t, timeZone)).toISOString().slice(0, 10);
}

// Excel stores dates as days since 1899-12-30.
function localSerial(t, timeZone) {
  return Number.isFinite(t) ? (t + zoneOffset(t, timeZone)) / 86400000 + 25569 : null;
}

function dateSerial(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ---------- Minimal .xlsx writer ---------- */
//
// A workbook is a zip of XML files. Strings are written as inline strings, so
// customer-entered text like "=HYPERLINK(...)" is never treated as a formula.

const XLSX_STYLES = { header: 1, money: 2, datetime: 3, date: 4, title: 5, int: 6, bold: 7, percent: 8 };
const XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function xlsx(sheets) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: XML_HEAD + `<workbook xmlns="${XLSX_NS}" xmlns:r="${REL_NS}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets>" + definedNames(sheets) + "</workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: XML_HEAD + `<styleSheet xmlns="${XLSX_NS}">` +
        '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>' +
        '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="14"/><color rgb="FF0F4D2A"/><name val="Calibri"/></font>' +
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FF0F4D2A"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="9">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files);
}

// Excel expects a hidden name for each sheet's filter range.
function definedNames(sheets) {
  const names = sheets
    .map((s, i) => (filterRange(s) ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(s.name)}'!${filterRange(s, true)}</definedName>` : ""))
    .join("");
  return names ? `<definedNames>${names}</definedNames>` : "";
}

// The header row and data, for sheets with a header row and at least one row.
function filterRange(sheet, absolute) {
  if (sheet.header === false || !sheet.rows.length) return "";
  const end = colName(sheet.columns.length - 1);
  return absolute ? `$A$1:$${end}$${sheet.rows.length + 1}` : `A1:${end}${sheet.rows.length + 1}`;
}

function sheetXml(sheet) {
  const hasHeader = sheet.header !== false;
  const rows = hasHeader ? [sheet.columns.map((c) => ({ v: c.header, type: "header" })), ...sheet.rows] : sheet.rows;
  let xml = XML_HEAD + `<worksheet xmlns="${XLSX_NS}" xmlns:r="${REL_NS}">`;
  xml += hasHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  xml += "<cols>" + sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("") + "</cols>";
  xml += "<sheetData>";
  rows.forEach((row, r) => {
    xml += `<row r="${r + 1}">`;
    row.forEach((cell, c) => {
      const spec = cell !== null && typeof cell === "object" ? cell : { v: cell };
      const type = spec.type || (hasHeader && sheet.columns[c] && sheet.columns[c].type) || "";
      xml += cellXml(colName(c) + (r + 1), spec.v, type);
    });
    xml += "</row>";
  });
  xml += "</sheetData>";
  if (filterRange(sheet)) xml += `<autoFilter ref="${filterRange(sheet)}"/>`;
  return xml + "</worksheet>";
}

function cellXml(ref, value, type) {
  if (value === null || value === undefined || value === "") return "";
  const s = XLSX_STYLES[type] ? ` s="${XLSX_STYLES[type]}"` : "";
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(String(value).slice(0, 32767))}</t></is></c>`;
}

function colName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function xmlText(value) {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A zip archive with uncompressed ("stored") entries, which every spreadsheet app reads.
function zip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
  const date = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------- Login and sessions ---------- */

async function login(request, env, url) {
  const missing = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET"].filter((name) => !env[name]);
  if (missing.length) {
    return json({ error: `Admin setup incomplete. Add ${missing.join(", ")} under Settings → Variables and Secrets on this Worker.` }, 500);
  }
  if (env.SESSION_SECRET.length < 32) return json({ error: "SESSION_SECRET must be at least 32 characters." }, 500);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await loginLimited(env, ip, false)) {
    return json({ error: "Too many failed sign-in attempts. Please wait 15 minutes, or use Sign in with Google." }, 429);
  }
  let email = "", password = "";
  try {
    const payload = JSON.parse(new TextDecoder().decode(await body(request, 8192)));
    email = String(payload.email || "").trim().toLowerCase();
    password = String(payload.password || "");
  } catch (err) {
    if (err.status === 413) throw err;
  }
  // Compare hashes so the check takes the same time whatever was typed, and
  // check both before answering so the reply doesn't reveal which was wrong.
  let emailOk = false;
  for (const allowed of adminEmails(env)) {
    if (safeEqual(await sha256(email), await sha256(allowed))) emailOk = true;
  }
  const passwordOk = safeEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD));
  if (!(emailOk && passwordOk)) {
    await loginLimited(env, ip, true);
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json({ error: "Wrong email or password." }, 401);
  }
  const token = await signSession(env, Date.now() + SESSION_HOURS * 3600 * 1000);
  return json({ ok: true, shopUrl: env.SHOP_URL || "" }, 200, { "Set-Cookie": cookie(token, SESSION_HOURS * 3600, url) });
}

// Failed password sign-ins: 5 per connection and 30 overall per 15 minutes.
// The admin backend has no storage, so the shop backend keeps the counters.
// With count, records a failure. If the shop can't be reached, sign-in isn't blocked.
async function loginLimited(env, ip, count) {
  if (!env.INTERNAL_API_KEY) return false;
  const checks = [["admin-login-ip", ip, 5], ["admin-login-all", "all", 30]];
  const results = await Promise.all(checks.map(async ([bucket, id, limit]) => {
    try {
      const res = await shopRequest(env, "POST", "throttle", JSON.stringify({ bucket, id, limit, window: 900, count }), "application/json");
      return res.ok && (await res.json()).limited === true;
    } catch (err) {
      console.error("Sign-in throttle unavailable", err);
      return false;
    }
  }));
  return !count && results.some(Boolean);
}

/* ---------- Sign in with Google (OAuth 2.0 / OpenID Connect) ---------- */

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const OAUTH_COOKIE = "admin_oauth";
let googleKeysCache = null;
let googleKeysExpiresAt = 0;

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
  if (!loginMethods(env).google || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return backToLogin(url, "Google sign-in isn't set up. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAIL and a SESSION_SECRET of at least 32 characters.");
  }
  const state = randomToken();
  const verifier = randomToken() + randomToken();
  const nonce = randomToken();
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/api/oauth/google/callback",
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: GOOGLE_AUTH + "?" + params,
      // Remembered for 10 minutes so the callback can check the reply is ours.
      "Set-Cookie": `${OAUTH_COOKIE}=${state}.${verifier}.${nonce}; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === "https:" ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
    },
  });
}

async function googleCallback(request, env, url) {
  const saved = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${OAUTH_COOKIE}=([^;]+)`));
  const [state, verifier, nonce] = saved ? saved[1].split(".") : [];
  const clear = `${OAUTH_COOKIE}=; Path=/api/oauth; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`;
  if (url.searchParams.get("error")) return backToLogin(url, "Google sign-in was cancelled.", clear);
  const code = url.searchParams.get("code");
  if (!code || !state || !verifier || !nonce || !safeEqual(url.searchParams.get("state") || "", state)) {
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
    if (!res.ok) return backToLogin(url, "Google sign-in failed. Please try again.", clear);
    tokens = await res.json();
  } catch (err) {
    console.error("Google token exchange failed", err);
    return backToLogin(url, "Couldn't reach Google. Please try again.", clear);
  }

  let claims;
  try {
    claims = await verifyGoogleIdToken(tokens && tokens.id_token);
  } catch (err) {
    console.error("Google ID token verification failed", err);
    return backToLogin(url, "Google sign-in failed. Please try again.", clear);
  }
  const now = Date.now() / 1000;
  if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub) {
    return backToLogin(url, "Google sign-in failed. Please try again.", clear);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expiresAt = Number(claims.exp);
  const issuedAt = Number(claims.iat);
  if (!audiences.includes(env.GOOGLE_CLIENT_ID) || (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID) || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || !Number.isFinite(expiresAt) || expiresAt <= now || !Number.isFinite(issuedAt) || issuedAt > now + 300 || !safeEqual(String(claims.nonce || ""), nonce)) {
    return backToLogin(url, "Google sign-in failed. Please try again.", clear);
  }
  const email = String(claims.email || "").toLowerCase();
  if (!(claims.email_verified === true || claims.email_verified === "true") || !adminEmails(env).includes(email)) {
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
  const nonce = randomToken();
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  });
  for (const c of cookies) headers.append("Set-Cookie", c);
  const target = JSON.stringify(location).replace(/</g, "\\u003c");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p><script nonce="${nonce}">location.replace(${target})</script>`,
    { status: 200, headers }
  );
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

async function verifyGoogleIdToken(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const header = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0])));
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported ID token signature");

  for (let attempt = 0; attempt < 2; attempt++) {
    const keys = await loadGoogleKeys(attempt > 0);
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
    if (!jwk) continue;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64url(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (valid) return JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
  }
  throw new Error("Invalid ID token signature");
}

async function loadGoogleKeys(forceRefresh) {
  if (!forceRefresh && googleKeysCache && googleKeysExpiresAt > Date.now()) return googleKeysCache;
  const response = await fetch(GOOGLE_KEYS);
  if (!response.ok) throw new Error("Google signing keys unavailable");
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Invalid Google signing keys");
  const cacheControl = response.headers.get("Cache-Control") || "";
  const maxAge = Number((cacheControl.match(/max-age=(\d+)/i) || [])[1]) || 3600;
  googleKeysCache = data.keys;
  googleKeysExpiresAt = Date.now() + Math.min(maxAge, 86400) * 1000;
  return googleKeysCache;
}

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Malformed base64url value");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hasSession(request, env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return false;
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

async function body(request, maxBytes = MAX_BODY_BYTES) {
  return readBoundedBody(request, maxBytes);
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
