(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const STOCK_LABELS = { in_stock: "In stock", limited: "Limited stock", new: "New arrival", sold_out: "Sold out" };

  const state = {
    products: [],
    settings: null,
    dirty: { products: false, settings: false },
    shopUrl: "",
    editing: -1, // index in state.products, or -1 for a new product
    draftPhoto: "",
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /* ---------- API ---------- */

  async function api(path, options = {}) {
    const res = await fetch("/api/" + path, { credentials: "same-origin", ...options });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== "login") {
      showLogin("Your session has ended. Please log in again.");
      throw new Error("Not logged in");
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const sendJson = (path, method, body) =>
    api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /* ---------- Views ---------- */

  function showLogin(message) {
    $('[data-view="app"]').hidden = true;
    $('[data-view="login"]').hidden = false;
    const err = $("[data-login-error]");
    err.textContent = message || "";
    err.hidden = !message;
    $('[name="password"]').focus();
  }

  async function showApp() {
    $('[data-view="login"]').hidden = true;
    $('[data-view="app"]').hidden = false;
    const link = $("[data-shop-link]");
    link.hidden = !state.shopUrl;
    if (state.shopUrl) link.href = state.shopUrl;
    try {
      const data = await api("catalog");
      state.products = data.products || [];
      state.settings = data.settings || {};
      setDirty("products", false);
      setDirty("settings", false);
      $("[data-brand]").textContent = (state.settings.brand && state.settings.brand.name) || "Store";
      renderProducts();
      fillSettings();
      renderOverview();
    } catch (err) {
      if (err.message !== "Not logged in") toast(err.message, true);
    }
  }

  function selectTab(name) {
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    $$("[data-page]").forEach((p) => (p.hidden = p.dataset.page !== name));
  }

  function setDirty(part, value) {
    state.dirty[part] = value;
    $(`[data-unsaved="${part}"]`).hidden = !value;
    $(part === "products" ? "[data-save-products]" : "[data-save-settings]").disabled = !value;
  }

  /* ---------- Products ---------- */

  function photoUrl(path) {
    if (!path) return "";
    return /^https:\/\//.test(path) ? path : "/preview/" + path;
  }

  function thumbHtml(p) {
    const src = photoUrl(p.photo);
    const fallback = `<span aria-hidden="true">${escapeHtml(p.emoji || "🧺")}</span>`;
    return src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" data-fallback="${escapeHtml(fallback)}">` : fallback;
  }

  function money(value) {
    const c = (state.settings && state.settings.currency) || {};
    try {
      return new Intl.NumberFormat(c.locale || "en-IN", { style: "currency", currency: c.code || "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value || 0);
    } catch {
      return String(value);
    }
  }

  function renderProducts() {
    const q = $("[data-product-search]").value.trim().toLowerCase();
    const list = $("[data-product-list]");
    const rows = state.products
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !q || [p.name, p.category, p.origin, p.id].some((s) => String(s || "").toLowerCase().includes(q)));

    list.innerHTML = rows
      .map(({ p, i }) => `
        <tr class="${p.visible === false ? "is-hidden" : ""}">
          <td class="col-photo"><div class="thumb">${thumbHtml(p)}</div></td>
          <td>
            <div class="cell-name">${escapeHtml(p.name)}</div>
            <div class="cell-sub">${escapeHtml(p.unit || "")}</div>
          </td>
          <td>${escapeHtml(p.category || "")}</td>
          <td>${escapeHtml(p.origin || "")}</td>
          <td class="num">${money(p.price)}</td>
          <td>
            <div class="badges">
              <span class="badge stock-${escapeHtml(p.stock || "in_stock")}">${STOCK_LABELS[p.stock] || "In stock"}</span>
              ${p.visible === false ? '<span class="badge">Hidden</span>' : ""}
              ${p.featured ? '<span class="badge featured">Slider</span>' : ""}
            </div>
          </td>
          <td class="col-actions">
            <div class="row-actions">
              <button class="icon-btn" type="button" data-move="${i}" data-dir="-1" aria-label="Move ${escapeHtml(p.name)} up" ${i === 0 || q ? "disabled" : ""}>↑</button>
              <button class="icon-btn" type="button" data-move="${i}" data-dir="1" aria-label="Move ${escapeHtml(p.name)} down" ${i === state.products.length - 1 || q ? "disabled" : ""}>↓</button>
              <button class="btn btn-ghost btn-sm" type="button" data-edit="${i}">Edit</button>
            </div>
          </td>
        </tr>`)
      .join("");

    $("[data-product-empty]").hidden = rows.length > 0;
    const hidden = state.products.filter((p) => p.visible === false).length;
    $("[data-product-count]").textContent = `${state.products.length} products${hidden ? ` (${hidden} hidden)` : ""}. Rows appear on the customer site in this order.`;

    // Suggestions for category and country fields.
    const opts = (key) => [...new Set(state.products.map((p) => p[key]).filter(Boolean))].sort()
      .map((v) => `<option value="${escapeHtml(v)}">`).join("");
    $("#category-options").innerHTML = opts("category");
    $("#origin-options").innerHTML = opts("origin");
  }

  /* ---------- Overview ---------- */

  function renderOverview() {
    const ps = state.products;
    const s = state.settings || {};
    const count = (fn) => ps.filter(fn).length;
    const live = count((p) => p.visible !== false);
    const stats = [
      ["Products", ps.length],
      ["Live on site", live],
      ["Hidden", ps.length - live],
      ["Sold out", count((p) => p.stock === "sold_out")],
      ["In homepage slider", count((p) => p.featured && p.visible !== false)],
    ];
    $("[data-stats]").innerHTML = stats
      .map(([label, value]) => `<div class="stat"><p class="stat-label">${label}</p><p class="stat-value">${value}</p></div>`)
      .join("");

    const issues = [];
    const whatsapp = s.orders && s.orders.whatsappNumber;
    if (!whatsapp) issues.push("WhatsApp number is not set, so orders are not being sent to you. Add it in Settings.");
    const noPhoto = ps.filter((p) => p.visible !== false && !p.photo);
    if (noPhoto.length) issues.push(`${noPhoto.length} live product${noPhoto.length > 1 ? "s have" : " has"} no photo: ${noPhoto.map((p) => p.name).join(", ")}.`);
    const soldOut = ps.filter((p) => p.visible !== false && p.stock === "sold_out");
    if (soldOut.length) issues.push(`Sold out: ${soldOut.map((p) => p.name).join(", ")}.`);
    const placeholder = /example\.com|00000/.test(`${s.brand && s.brand.email} ${s.brand && s.brand.phone}`);
    if (placeholder) issues.push("The contact email or phone is still a placeholder. Update it in Settings.");
    if (!count((p) => p.featured && p.visible !== false && p.photo)) issues.push("No products are in the homepage slider.");
    $("[data-attention]").innerHTML = issues.length
      ? issues.map((t) => `<li><span class="dot" aria-hidden="true"></span><span>${escapeHtml(t)}</span></li>`).join("")
      : '<li><span class="dot ok" aria-hidden="true"></span><span>Everything looks good.</span></li>';

    const m = s.minOrder || {};
    const rows = [
      ["Store name", (s.brand && s.brand.name) || "Not set"],
      ["WhatsApp orders", whatsapp ? "+" + whatsapp : "Off"],
      ["Minimum order", m.value ? (m.unit === "amount" ? money(m.value) : `${m.value} items`) : "None"],
      ["Currency", (s.currency && s.currency.code) || "INR"],
      ["Customer site", state.shopUrl || "Not set (SHOP_URL)"],
    ];
    $("[data-setup]").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  }

  function moveProduct(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.products.length) return;
    [state.products[i], state.products[j]] = [state.products[j], state.products[i]];
    setDirty("products", true);
    renderProducts();
  }

  function openEditor(index) {
    state.editing = index;
    const p = index >= 0 ? state.products[index] : { visible: true, stock: "in_stock", featured: false, price: "", tint: "#f6f8ef" };
    const form = $("[data-editor-form]");
    form.reset();
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") el.checked = el.name === "visible" ? p.visible !== false : !!p[el.name];
      else if (el.type === "color") el.value = /^#[0-9a-f]{6}$/i.test(p.tint || "") ? p.tint : "#f6f8ef";
      else el.value = p[el.name] == null ? "" : p[el.name];
    }
    state.draftPhoto = p.photo || "";
    renderPhotoPreview(p);
    $("[data-editor-title]").textContent = index >= 0 ? "Edit product" : "New product";
    $("[data-editor-delete]").hidden = index < 0;
    $("[data-editor-error]").hidden = true;
    $("[data-editor]").showModal();
    form.elements.name.focus();
  }

  function renderPhotoPreview(p) {
    const box = $("[data-photo-preview]");
    const src = photoUrl(state.draftPhoto);
    box.innerHTML = src ? `<img src="${escapeHtml(src)}" alt="">` : `<span aria-hidden="true">${escapeHtml((p && p.emoji) || $('[name="emoji"]').value || "🧺")}</span>`;
    $("[data-photo-remove]").hidden = !state.draftPhoto;
  }

  function slug(v) {
    return String(v || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }

  function applyEditor() {
    const form = $("[data-editor-form]");
    const err = $("[data-editor-error]");
    const v = (name) => form.elements[name].value.trim();
    const name = v("name");
    const id = slug(v("id") || name);
    const price = Number(v("price"));
    const clash = state.products.findIndex((p, i) => p.id === id && i !== state.editing);
    let problem = "";
    if (!name) problem = "Please enter a name.";
    else if (!id) problem = "Please enter a product code.";
    else if (clash >= 0) problem = `Another product already uses the code "${id}".`;
    else if (!Number.isFinite(price) || price < 0 || v("price") === "") problem = "Please enter a valid price.";
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return false;
    }
    const base = state.editing >= 0 ? state.products[state.editing] : {};
    const product = {
      ...base,
      id, name, price,
      unit: v("unit"),
      category: v("category"),
      origin: v("origin"),
      description: v("description"),
      stock: v("stock"),
      visible: form.elements.visible.checked,
      featured: form.elements.featured.checked,
      photo: state.draftPhoto,
      photoCreditTitle: v("photoCreditTitle"),
      photoCreditUrl: v("photoCreditUrl"),
      emoji: v("emoji"),
      tint: form.elements.tint.value,
    };
    if (state.editing >= 0) state.products[state.editing] = product;
    else state.products.push(product);
    setDirty("products", true);
    renderProducts();
    return true;
  }

  async function uploadPhoto(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Photos must be 5 MB or smaller.", true);
    const box = $("[data-photo-preview]");
    box.innerHTML = '<span class="muted" style="font-size:.9rem">Uploading…</span>';
    try {
      const name = encodeURIComponent(file.name.replace(/\.[^.]+$/, ""));
      const data = await api("photos?name=" + name, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      state.draftPhoto = data.path;
      // Uploaded photos from Wikimedia etc. no longer need that credit.
      $('[name="photoCreditTitle"]').value = "";
      $('[name="photoCreditUrl"]').value = "";
      toast("Photo uploaded. Click Done, then Save changes.");
    } catch (err) {
      toast(err.message, true);
    }
    renderPhotoPreview();
  }

  async function saveProducts() {
    const btn = $("[data-save-products]");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const data = await sendJson("products", "PUT", { products: state.products });
      state.products = data.products;
      setDirty("products", false);
      renderProducts();
      renderOverview();
      toast("Saved. The customer site updates within a minute.");
    } catch (err) {
      if (err.message !== "Not logged in") toast(err.message, true);
      btn.disabled = false;
    }
    btn.textContent = "Save changes";
  }

  /* ---------- Settings ---------- */

  function fillSettings() {
    const form = $("[data-settings-form]");
    for (const el of form.elements) {
      if (!el.name) continue;
      const [group, key] = el.name.split(".");
      const value = state.settings[group] && state.settings[group][key];
      el.value = value == null ? "" : value;
    }
  }

  function readSettings() {
    const form = $("[data-settings-form]");
    const out = JSON.parse(JSON.stringify(state.settings || {}));
    for (const el of form.elements) {
      if (!el.name) continue;
      const [group, key] = el.name.split(".");
      out[group] = out[group] || {};
      out[group][key] = el.value.trim();
    }
    return out;
  }

  async function saveSettings() {
    const form = $("[data-settings-form]");
    if (!form.reportValidity()) return;
    const btn = $("[data-save-settings]");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const data = await sendJson("settings", "PUT", { settings: readSettings() });
      state.settings = data.settings;
      fillSettings();
      setDirty("settings", false);
      $("[data-brand]").textContent = state.settings.brand.name;
      renderProducts(); // currency may have changed
      renderOverview();
      toast("Settings saved. The customer site updates within a minute.");
    } catch (err) {
      if (err.message !== "Not logged in") toast(err.message, true);
      btn.disabled = false;
    }
    btn.textContent = "Save settings";
  }

  /* ---------- Toast ---------- */

  let toastTimer;
  function toast(message, isError) {
    const el = $("[data-toast]");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 2800);
  }

  /* ---------- Events ---------- */

  $("[data-login-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const data = await sendJson("login", "POST", { password: e.target.elements.password.value });
      state.shopUrl = data.shopUrl || "";
      e.target.reset();
      await showApp();
    } catch (err) {
      showLogin(err.message);
    }
    btn.disabled = false;
  });

  $("[data-logout]").addEventListener("click", async () => {
    if ((state.dirty.products || state.dirty.settings) && !confirm("You have unsaved changes. Log out anyway?")) return;
    try { await api("logout", { method: "POST" }); } catch {}
    setDirty("products", false);
    setDirty("settings", false);
    showLogin();
  });

  $$("[data-tab]").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));
  $("[data-product-search]").addEventListener("input", renderProducts);
  $("[data-add-product]").addEventListener("click", () => openEditor(-1));
  $("[data-save-products]").addEventListener("click", saveProducts);
  $("[data-save-settings]").addEventListener("click", saveSettings);
  $("[data-settings-form]").addEventListener("input", () => setDirty("settings", true));
  $("[data-settings-form]").addEventListener("submit", (e) => e.preventDefault());

  $("[data-product-list]").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.edit) openEditor(Number(btn.dataset.edit));
    if (btn.dataset.move) moveProduct(Number(btn.dataset.move), Number(btn.dataset.dir));
  });

  const editor = $("[data-editor]");
  $("[data-editor-form]").addEventListener("submit", (e) => {
    if (!applyEditor()) e.preventDefault();
  });
  $$("[data-editor-cancel]").forEach((b) => b.addEventListener("click", () => editor.close()));
  $("[data-editor-delete]").addEventListener("click", () => {
    const p = state.products[state.editing];
    if (!p || !confirm(`Delete "${p.name}"? You can undo this until you click Save changes, by reloading the page.`)) return;
    state.products.splice(state.editing, 1);
    setDirty("products", true);
    renderProducts();
    editor.close();
  });
  $("[data-photo-input]").addEventListener("change", (e) => {
    uploadPhoto(e.target.files[0]);
    e.target.value = "";
  });
  $("[data-photo-remove]").addEventListener("click", () => {
    state.draftPhoto = "";
    renderPhotoPreview();
  });
  $('[name="emoji"]').addEventListener("input", () => { if (!state.draftPhoto) renderPhotoPreview(); });

  // Photos that can't load (e.g. an outside address) fall back to the emoji.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback) img.outerHTML = img.dataset.fallback;
  }, true);

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty.products || state.dirty.settings) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------- Start ---------- */

  (async function start() {
    try {
      const session = await api("session");
      state.shopUrl = session.shopUrl || "";
      if (session.loggedIn) await showApp();
      else showLogin();
    } catch (err) {
      showLogin("Could not reach the admin backend.");
    }
  })();
})();
