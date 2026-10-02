(async function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- Data ---------- */

  // Products and settings come from the shop backend (shop-api), which the
  // admin panel updates. If the backend isn't there (e.g. a static preview),
  // fall back to the catalogue bundled in data/*.json.
  async function loadJson(path, options = {}) {
    const res = await fetch(path, { cache: "no-cache", ...options });
    if (!res.ok) {
      let message = path + ": " + res.status;
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch {}
      throw new Error(message);
    }
    return res.json();
  }

  async function loadCatalogue() {
    try {
      const data = await loadJson("api/catalog");
      if (data && data.settings && Array.isArray(data.products)) return [data.settings, data];
    } catch (err) {
      console.info("Shop backend not available, using bundled data.", err.message);
    }
    return Promise.all([loadJson("data/settings.json"), loadJson("data/products.json")]);
  }

  let config, catalogue;
  try {
    [config, catalogue] = await loadCatalogue();
  } catch (err) {
    console.error("Could not load shop data", err);
    $("[data-product-grid]").innerHTML =
      '<p class="empty-state">Sorry, the shop could not be loaded. Please refresh the page.</p>';
    return;
  }

  // Accept an empty minimum ("" or null) as "no minimum".
  const moqValue = parseInt(config.minOrder && config.minOrder.value, 10);
  config.minOrder = { unit: "items", pendingMessage: "", ...config.minOrder, value: moqValue > 0 ? moqValue : null };
  config.orders = config.orders || {};

  const STOCK_LABELS = { limited: "Limited stock", new: "New arrival", sold_out: "Sold out" };

  // Turn an admin-edited product record into the shape the page uses.
  function normalizeProduct(p) {
    return {
      ...p,
      id: String(p.id || p.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      // No price means "price on request": shown as such and left out of totals.
      price: p.price === null || p.price === "" || p.price === undefined || !Number.isFinite(Number(p.price)) ? null : Number(p.price),
      emoji: p.emoji || "🧺",
      image: p.illustration || "",
      tint: p.tint || "#f6f8ef",
      category: p.category || "Other",
      origin: p.origin || "",
      unit: p.unit || "",
      description: p.description || "",
      photo: p.photo ? { src: p.photo, source: p.photoCreditUrl || "", title: p.photoCreditTitle || "" } : null,
      soldOut: p.stock === "sold_out",
    };
  }

  const products = (catalogue.products || [])
    .filter((p) => p.visible !== false && p.name)
    .map(normalizeProduct);
  const productById = new Map(products.map((p) => [p.id, p]));
  const CART_KEY = "fruit-shop-cart";

  const FLAGS = {
    "Afghanistan": "🇦🇫", "Argentina": "🇦🇷", "Australia": "🇦🇺", "Belgium": "🇧🇪", "Bhutan": "🇧🇹", "Brazil": "🇧🇷",
    "Canada": "🇨🇦", "Chile": "🇨🇱", "China": "🇨🇳", "Colombia": "🇨🇴", "Costa Rica": "🇨🇷",
    "Ecuador": "🇪🇨", "Egypt": "🇪🇬", "France": "🇫🇷", "Greece": "🇬🇷", "India": "🇮🇳",
    "Indonesia": "🇮🇩", "Iran": "🇮🇷", "Israel": "🇮🇱", "Italy": "🇮🇹", "Japan": "🇯🇵",
    "Kenya": "🇰🇪", "Malaysia": "🇲🇾", "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Nepal": "🇳🇵",
    "Netherlands": "🇳🇱", "New Zealand": "🇳🇿", "Pakistan": "🇵🇰", "Peru": "🇵🇪",
    "Philippines": "🇵🇭", "Poland": "🇵🇱", "Portugal": "🇵🇹", "South Africa": "🇿🇦",
    "South Korea": "🇰🇷", "Spain": "🇪🇸", "Sri Lanka": "🇱🇰", "Taiwan": "🇹🇼", "Thailand": "🇹🇭",
    "Turkey": "🇹🇷", "UAE": "🇦🇪", "UK": "🇬🇧", "USA": "🇺🇸", "Vietnam": "🇻🇳",
    "Russia": "🇷🇺", "Serbia": "🇷🇸", "Tanzania": "🇹🇿",
  };

  const money = new Intl.NumberFormat(config.currency.locale, {
    style: "currency",
    currency: config.currency.code,
    maximumFractionDigits: 0,
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  /* ---------- Branding ---------- */

  function applyBranding() {
    const { brand } = config;
    $$("[data-brand-name]").forEach((el) => (el.textContent = brand.name));
    $$("[data-brand-tagline]").forEach((el) => (el.textContent = brand.tagline));
    $$("[data-brand-email]").forEach((el) => {
      el.textContent = brand.email;
      el.href = "mailto:" + brand.email;
    });
    $$("[data-brand-phone]").forEach((el) => {
      el.textContent = brand.phone;
      el.href = "tel:" + brand.phone.replace(/\s+/g, "");
    });
    $$("[data-brand-address]").forEach((el) => {
      el.textContent = brand.address || "";
      el.hidden = !brand.address;
    });
    $$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
    const hero = config.hero || {};
    if (hero.eyebrow) $("[data-hero-eyebrow]").textContent = hero.eyebrow;
    if (hero.title) $("[data-hero-title]").textContent = hero.title + " ";
    $("[data-hero-highlight]").textContent = hero.titleHighlight || "";
    if (config.orders && config.orders.deliveryNote) $("[data-delivery-note]").textContent = config.orders.deliveryNote;
    document.title = brand.name + " | Exotic Imported Fruits";
  }

  /* ---------- Minimum order ---------- */

  function moqMessage() {
    const { value, unit, pendingMessage } = config.minOrder;
    if (value == null) return pendingMessage;
    return unit === "amount"
      ? "Minimum order value: " + money.format(value) + "."
      : "Minimum order: " + value + " items.";
  }

  function moqShortfall() {
    const { value, unit } = config.minOrder;
    if (value == null) return null;
    const current = unit === "amount" ? cartSubtotal() : cartItemCount();
    if (current >= value) return null;
    return unit === "amount"
      ? "Add " + money.format(value - current) + " more to reach the minimum order value."
      : "Add " + (value - current) + " more item(s) to reach the minimum order.";
  }

  /* ---------- Cart state ---------- */

  let cart = loadCart();

  function loadCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(CART_KEY) || "{}");
      // Drop anything that is no longer in the catalogue.
      return Object.fromEntries(
        Object.entries(saved).filter(([id, qty]) => productById.has(id) && !productById.get(id).soldOut && qty > 0)
      );
    } catch (e) {
      return {};
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (e) {
      /* storage unavailable, cart still works for this visit */
    }
  }

  function setQty(id, qty) {
    if (qty <= 0) delete cart[id];
    else cart[id] = Math.min(qty, 99);
    saveCart();
    renderCart();
    renderProductButtons();
  }

  const cartItemCount = () => Object.values(cart).reduce((a, b) => a + b, 0);
  const cartSubtotal = () =>
    Object.entries(cart).reduce((sum, [id, qty]) => sum + (productById.get(id).price || 0) * qty, 0);
  const cartHasUnpriced = () => Object.keys(cart).some((id) => productById.get(id).price === null);
  const cartHasPriced = () => Object.keys(cart).some((id) => productById.get(id).price !== null);
  function subtotalText() {
    if (!cartHasPriced()) return "Price on request";
    return money.format(cartSubtotal()) + (cartHasUnpriced() ? " + items on request" : "");
  }
  const unitText = (p) => (p.unit ? ` / ${p.unit}` : "");
  const priceText = (p) => (p.price === null ? "Price on request" : money.format(p.price) + unitText(p));

  /* ---------- Product grid ---------- */

  const filters = { search: "", origin: "", category: "" };

  // Illustrations (SVG) are shown contained; photos fill the card.
  function artHtml(p, alt) {
    if (!p.image) return `<span class="product-emoji" aria-hidden="true">${escapeHtml(p.emoji)}</span>`;
    const cls = /\.svg$/i.test(p.image) ? "illustration" : "photo";
    return `<img class="${cls}" src="${escapeHtml(p.image)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  }

  // A real `photo` is shown when the file exists; until it is uploaded the
  // emoji / illustration is swapped back in (see the error listener below).
  // `photo` is either a path/URL string or a Commons record ({src, source, title}).
  const photoSrc = (p) => (typeof p.photo === "string" ? p.photo : p.photo && p.photo.src);

  function mediaHtml(p, alt) {
    const src = photoSrc(p);
    if (!src) return artHtml(p, alt);
    return `<img class="photo" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(artHtml(p, alt))}">`;
  }

  function renderCredits() {
    const items = products.filter((p) => p.photo && /^https:\/\//i.test(p.photo.source));
    $("[data-credits-wrap]").hidden = items.length === 0;
    $("[data-credits]").innerHTML = items
      .map((p) => `<li>${escapeHtml(p.name)}: <a href="${escapeHtml(p.photo.source)}" target="_blank" rel="noopener">${escapeHtml(p.photo.title)}</a></li>`)
      .join("");
  }

  function productCard(p) {
    const media = mediaHtml(p, p.name);
    return `
      <article class="product-card${p.soldOut ? " sold-out" : ""}" data-id="${escapeHtml(p.id)}">
        <div class="product-media" style="background:${escapeHtml(p.tint)}">
          ${media}
          <span class="origin-badge">${FLAGS[p.origin] || "🌍"} ${escapeHtml(p.origin)}</span>
          ${STOCK_LABELS[p.stock] ? `<span class="stock-badge stock-${escapeHtml(p.stock)}">${STOCK_LABELS[p.stock]}</span>` : ""}
        </div>
        <div class="product-info">
          <p class="product-category">${escapeHtml(p.category)}</p>
          <h3>${escapeHtml(p.name)}</h3>
          ${p.origin ? `<p class="product-origin">${FLAGS[p.origin] || "🌍"} Imported from <strong>${escapeHtml(p.origin)}</strong></p>` : ""}
          <p class="product-desc">${escapeHtml(p.description)}</p>
          ${p.price === null
            ? `<p class="product-price on-request">Price on request${p.unit ? ` <span>/ ${escapeHtml(p.unit)}</span>` : ""}</p>`
            : `<p class="product-price">${money.format(p.price)}${p.unit ? ` <span>/ ${escapeHtml(p.unit)}</span>` : ""}</p>`}
        </div>
        <div class="product-action" data-action></div>
      </article>`;
  }

  function actionHtml(id) {
    if (productById.get(id).soldOut) {
      return `<button class="btn btn-primary btn-block" type="button" disabled>Sold out</button>`;
    }
    const qty = cart[id] || 0;
    if (!qty) {
      return `<button class="btn btn-primary btn-block" type="button" data-add="${escapeHtml(id)}">Add to Cart</button>`;
    }
    return `
      <div class="qty-control" role="group" aria-label="Quantity">
        <button type="button" data-dec="${id}" aria-label="Decrease quantity">−</button>
        <span>${qty} in cart</span>
        <button type="button" data-inc="${id}" aria-label="Increase quantity">+</button>
      </div>`;
  }

  function matches(p) {
    const q = filters.search.trim().toLowerCase();
    return (
      (!filters.origin || p.origin === filters.origin) &&
      (!filters.category || p.category === filters.category) &&
      (!q || [p.name, p.origin, p.category].some((s) => s.toLowerCase().includes(q)))
    );
  }

  function renderProducts() {
    const list = products.filter(matches);
    $("[data-product-grid]").innerHTML = list.map(productCard).join("");
    $("[data-empty]").hidden = list.length > 0;
    renderProductButtons();
  }

  function renderProductButtons() {
    $$(".product-card").forEach((card) => {
      $("[data-action]", card).innerHTML = actionHtml(card.dataset.id);
    });
  }

  function renderFilters() {
    const origins = [...new Set(products.map((p) => p.origin))].sort();
    $("[data-origin-filter]").insertAdjacentHTML(
      "beforeend",
      origins.map((o) => `<option value="${escapeHtml(o)}">${FLAGS[o] || ""} ${escapeHtml(o)}</option>`).join("")
    );

    const categories = ["", ...new Set(products.map((p) => p.category))];
    $("[data-category-chips]").innerHTML = categories
      .map((c) => `<button type="button" class="chip" data-category="${escapeHtml(c)}" aria-pressed="${c === ""}">${escapeHtml(c || "All")}</button>`)
      .join("");
  }

  /* ---------- Cart drawer ---------- */

  function renderCart() {
    const entries = Object.entries(cart);
    const count = cartItemCount();

    $$("[data-cart-count]").forEach((el) => {
      el.textContent = count;
      el.classList.toggle("has-items", count > 0);
    });

    $("[data-cart-items]").innerHTML = entries
      .map(([id, qty]) => {
        const p = productById.get(id);
        return `
          <li class="cart-item">
            <span class="cart-thumb" style="background:${escapeHtml(p.tint)}" aria-hidden="true">${mediaHtml(p, "")}</span>
            <div class="cart-item-info">
              <p class="cart-item-name">${escapeHtml(p.name)}</p>
              <p class="muted small">${FLAGS[p.origin] || ""} ${escapeHtml(p.origin)}${p.price === null ? "" : " · " + escapeHtml(priceText(p))}</p>
              <div class="qty-control qty-sm" role="group" aria-label="Quantity for ${escapeHtml(p.name)}">
                <button type="button" data-dec="${id}" aria-label="Decrease quantity">−</button>
                <span>${qty}</span>
                <button type="button" data-inc="${id}" aria-label="Increase quantity">+</button>
              </div>
            </div>
            <div class="cart-item-end">
              <strong>${p.price === null ? "On request" : money.format(p.price * qty)}</strong>
              <button type="button" class="btn-link small" data-remove="${id}">Remove</button>
            </div>
          </li>`;
      })
      .join("");

    const empty = entries.length === 0;
    const success = !$("[data-success]").hidden;
    $("[data-cart-empty]").hidden = !empty || success;
    $("[data-cart-foot]").hidden = empty || success;
    if (empty) $("[data-checkout]").hidden = true;

    $("[data-cart-subtotal]").textContent = subtotalText();
    const shortfall = moqShortfall();
    $("[data-moq-cart]").textContent = shortfall || moqMessage();
    $("[data-checkout-btn]").disabled = !!shortfall;
  }

  function openCart() {
    $("#cart").classList.add("open");
    $("#cart").setAttribute("aria-hidden", "false");
    $(".cart-toggle").setAttribute("aria-expanded", "true");
    $("[data-overlay]").hidden = false;
    document.body.classList.add("no-scroll");
    $("[data-cart-close]").focus();
  }

  function closeCart() {
    $("#cart").classList.remove("open");
    $("#cart").setAttribute("aria-hidden", "true");
    $(".cart-toggle").setAttribute("aria-expanded", "false");
    $("[data-overlay]").hidden = true;
    document.body.classList.remove("no-scroll");
    // Reset post-order view so the next open shows the cart again.
    if (!$("[data-success]").hidden) {
      $("[data-success]").hidden = true;
      renderCart();
    }
  }

  /* ---------- Location ---------- */

  function setLocationStatus(html, state) {
    const el = $("[data-location-status]");
    el.innerHTML = html;
    el.dataset.state = state || "";
  }

  function clearLocation() {
    const form = $("[data-checkout]");
    ["latitude", "longitude", "locationAccuracy"].forEach((n) => (form.elements[n].value = ""));
    $("[data-locate]").textContent = "📍 Use my current location";
    setLocationStatus("Share your precise location so our driver can find you easily.");
  }

  // Asks the browser for the customer's precise position. The browser shows
  // its own permission prompt; the address field stays the fallback.
  function requestLocation() {
    if (!("geolocation" in navigator)) {
      setLocationStatus("Location isn't available in this browser. Please enter your address above.", "error");
      return;
    }
    const btn = $("[data-locate]");
    btn.disabled = true;
    setLocationStatus("Getting your precise location…", "pending");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const form = $("[data-checkout]");
        form.elements.latitude.value = latitude.toFixed(6);
        form.elements.longitude.value = longitude.toFixed(6);
        form.elements.locationAccuracy.value = Math.round(accuracy);
        const mapUrl = "https://www.google.com/maps?q=" + latitude.toFixed(6) + "," + longitude.toFixed(6);
        setLocationStatus(
          `✅ Location captured (accurate to about ${Math.round(accuracy)} m). ` +
          `<a href="${mapUrl}" target="_blank" rel="noopener">View on map</a>`,
          "ok"
        );
        btn.textContent = "📍 Update location";
        btn.disabled = false;
      },
      (err) => {
        const messages = {
          1: "Location permission was denied. You can allow it in your browser settings, or just enter your address above.",
          2: "We couldn't determine your location. Please try again or enter your address above.",
          3: "Getting your location took too long. Please try again.",
        };
        setLocationStatus(messages[err.code] || messages[2], "error");
        btn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  /* ---------- Checkout ---------- */

  // Builds a wa.me link carrying the whole order as a pre-filled message,
  // or null when no WhatsApp number is configured.
  function whatsappOrderUrl(customer) {
    const number = String(config.orders.whatsappNumber || "").replace(/\D/g, "");
    if (!number) return null;

    const lines = [
      `*New order: ${config.brand.name}*`,
      "",
      ...Object.entries(cart).map(([id, qty]) => {
        const p = productById.get(id);
        const what = `${p.name} from ${p.origin}${p.unit ? ` (${p.unit})` : ""}`;
        return `• ${what} × ${qty} = ${p.price === null ? "price on request" : money.format(p.price * qty)}`;
      }),
      "",
      cartHasPriced() ? `*Subtotal: ${subtotalText()}*` : "*Prices: please confirm*",
      "Delivery charges to be confirmed.",
      "",
      `Name: ${customer.name}`,
      `Phone: ${customer.phone}`,
      `Address: ${customer.address}`,
    ];
    if (customer.latitude && customer.longitude) {
      lines.push(
        `Location: https://www.google.com/maps?q=${customer.latitude},${customer.longitude}` +
        (customer.locationAccuracy ? ` (±${customer.locationAccuracy} m)` : "")
      );
    }
    return "https://wa.me/" + number + "?text=" + encodeURIComponent(lines.join("\n"));
  }

  async function handleCheckout() {
    const form = $("[data-checkout]");
    const btn = $("[data-checkout-btn]");
    const error = $("[data-form-error]");

    if (form.hidden) {
      form.hidden = false;
      fillCheckoutFromAccount();
      if (!form.elements.latitude.value) requestLocation();
      btn.textContent = config.orders.whatsappNumber ? "Place order on WhatsApp" : "Place order";
      $("input", form).focus();
      return;
    }

    const shortfall = moqShortfall();
    if (shortfall) {
      error.textContent = shortfall;
      error.hidden = false;
      return;
    }

    if (!form.checkValidity()) {
      error.textContent = "Please fill in your name, a valid email, phone and address.";
      error.hidden = false;
      const firstInvalid = $$(":invalid", form)[0];
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const customer = Object.fromEntries(new FormData(form));
    const waUrl = whatsappOrderUrl(customer);
    const whatsappWindow = waUrl ? window.open("about:blank", "_blank") : null;
    if (whatsappWindow) whatsappWindow.opener = null;
    btn.disabled = true;
    error.hidden = true;
    try {
      const result = await sendOrder(customer);
      if (whatsappWindow && !whatsappWindow.closed) whatsappWindow.location.replace(waUrl);

      const link = $("[data-whatsapp-link]");
      $("[data-success-whatsapp]").hidden = !waUrl;
      $("[data-success-plain]").hidden = !!waUrl;
      if (waUrl) link.href = waUrl;
      $("[data-order-email-note]").textContent = result.emailSent
        ? `Order ${result.orderId.slice(-8).toUpperCase()} saved. A confirmation and future status updates were emailed to ${customer.email}.`
        : `Order ${result.orderId.slice(-8).toUpperCase()} saved, but the email could not be sent. Please contact us to confirm your order.`;
      // The shop remembers the latest delivery details on the account.
      if (customer) Object.assign(customer, { phone: form.elements.phone.value.trim(), address: form.elements.address.value.trim() });

      form.reset();
      clearLocation();
      form.hidden = true;
      btn.textContent = "Checkout";
      cart = {};
      saveCart();
      $("[data-success]").hidden = false;
      renderCart();
      renderProductButtons();
    } catch (err) {
      if (whatsappWindow && !whatsappWindow.closed) whatsappWindow.close();
      error.textContent = err.message || "We couldn't save your order. Please try again.";
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function sendOrder(customer) {
    return loadJson("api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          address: customer.address,
          latitude: customer.latitude,
          longitude: customer.longitude,
          locationAccuracy: customer.locationAccuracy,
        },
        items: Object.entries(cart).map(([id, quantity]) => ({ id, quantity: Number(quantity) })),
      }),
    });
  }

  /* ---------- Customer account ---------- */

  // The session cookie is HttpOnly; the page only knows who is signed in
  // from /api/account.
  let customer = null;
  let resetToken = "";
  const AUTH_TITLES = {
    login: "Sign in",
    register: "Create your account",
    forgot: "Reset your password",
    reset: "Choose a new password",
    account: "Your account",
  };
  const ORDER_STATUS_LABELS = {
    received: "Order received",
    confirmed: "Confirmed",
    preparing: "Preparing",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };

  const postJson = (path, body) =>
    loadJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function loadAccount() {
    try {
      customer = (await loadJson("api/account")).customer || null;
      $("[data-account-btn]").hidden = false;
    } catch {
      // No shop backend (e.g. a static preview): accounts aren't available.
      customer = null;
    }
    renderAccountState();
  }

  function setCustomer(value) {
    customer = value;
    renderAccountState();
  }

  function renderAccountState() {
    const first = customer ? customer.name.split(/\s+/)[0] : "";
    $("[data-account-label]").textContent = customer ? first || "Account" : "Sign in";
    $("[data-account-btn]").setAttribute("aria-label", customer ? "Your account" : "Sign in or create an account");

    const note = $("[data-checkout-account]");
    note.hidden = $("[data-account-btn]").hidden;
    note.innerHTML = customer
      ? `Signed in as <strong>${escapeHtml(customer.email)}</strong>. This order will appear in your account.`
      : `<button class="btn-link" type="button" data-auth-open="login">Sign in</button> or <button class="btn-link" type="button" data-auth-open="register">create an account</button> to fill in your details and follow your orders.`;
    fillCheckoutFromAccount();
  }

  // Fill empty delivery fields from the account; never overwrite typing.
  function fillCheckoutFromAccount() {
    if (!customer) return;
    const form = $("[data-checkout]");
    for (const name of ["name", "email", "phone", "address"]) {
      if (!form.elements[name].value && customer[name]) form.elements[name].value = customer[name];
    }
  }

  function showAuth(view, note) {
    const dialog = $("[data-auth]");
    $("[data-auth-title]").textContent = AUTH_TITLES[view];
    $$("[data-auth-form]", dialog).forEach((el) => {
      el.hidden = el.dataset.authForm !== view;
      const error = $("[data-auth-error]", el);
      if (error) error.hidden = true;
    });
    const noteEl = $("[data-auth-note]");
    noteEl.textContent = note || "";
    noteEl.hidden = !note;
    if (view === "account") renderAccount();
    if (!dialog.open) dialog.showModal();
    const first = $(`[data-auth-form="${view}"] input`, dialog);
    if (first) first.focus();
  }

  function closeAuth() {
    $("[data-auth]").close();
  }

  async function renderAccount() {
    if (!customer) return;
    const rows = [["Name", customer.name], ["Email", customer.email], ["Phone", customer.phone], ["Delivery address", customer.address]]
      .filter(([, value]) => value);
    $("[data-account-details]").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");

    const status = $("[data-account-orders-status]");
    const list = $("[data-account-orders]");
    status.textContent = "Loading your orders…";
    list.innerHTML = "";
    try {
      const { orders } = await loadJson("api/account/orders");
      status.textContent = orders.length ? "" : "You haven't placed any orders while signed in yet.";
      list.innerHTML = orders.map((order) => {
        const date = new Date(order.createdAt);
        const items = order.items.map((i) => `${i.quantity} × ${escapeHtml(i.name)}`).join(", ");
        let total = "Price on request";
        if (order.subtotal || !order.hasUnpricedItems) {
          try {
            total = new Intl.NumberFormat(order.currency.locale, { style: "currency", currency: order.currency.code }).format(order.subtotal);
          } catch {
            total = String(order.subtotal);
          }
          if (order.hasUnpricedItems) total += " + items on request";
        }
        return `<li>
          <div class="account-order-head">
            <span>Order ${escapeHtml(order.id.slice(-8).toUpperCase())}</span>
            <span class="order-status status-${escapeHtml(order.status)}">${escapeHtml(ORDER_STATUS_LABELS[order.status] || order.status)}</span>
          </div>
          <p class="muted small">${Number.isNaN(date.getTime()) ? "" : escapeHtml(date.toLocaleString())} · ${escapeHtml(total)}</p>
          <p class="small">${items}</p>
        </li>`;
      }).join("");
    } catch (err) {
      if (/sign in/i.test(err.message)) {
        setCustomer(null);
        showAuth("login", "Your session has ended. Please sign in again.");
      } else {
        status.textContent = "We couldn't load your orders. Please try again.";
      }
    }
  }

  async function submitAuth(form) {
    const view = form.dataset.authForm;
    const error = $("[data-auth-error]", form);
    const button = $('button[type="submit"]', form);
    const values = Object.fromEntries(new FormData(form));
    error.hidden = true;
    if (!form.checkValidity()) {
      error.textContent = view === "register" ? "Please enter your name, a valid email and a password of at least 8 characters."
        : view === "reset" ? "Use a password of at least 8 characters."
        : "Please fill in the fields above.";
      error.hidden = false;
      const firstInvalid = $(":invalid", form);
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    button.disabled = true;
    try {
      if (view === "forgot") {
        const result = await postJson("api/auth/forgot", { email: values.email });
        form.reset();
        showAuth("login", result.message);
        return;
      }
      const path = view === "reset" ? "api/auth/reset" : "api/auth/" + view;
      const result = await postJson(path, view === "reset" ? { token: resetToken, password: values.password } : values);
      resetToken = "";
      form.reset();
      setCustomer(result.customer);
      closeAuth();
      toast(view === "register" ? "Welcome, " + result.customer.name + "! Your account is ready." : view === "reset" ? "Password changed. You're signed in." : "Signed in.");
    } catch (err) {
      error.textContent = err.message || "Something went wrong. Please try again.";
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  async function signOut() {
    try {
      await postJson("api/auth/logout", {});
    } catch {}
    setCustomer(null);
    const form = $("[data-checkout]");
    form.reset();
    clearLocation();
    closeAuth();
    toast("Signed out.");
  }

  function bindAccountEvents() {
    const dialog = $("[data-auth]");
    $("[data-account-btn]").addEventListener("click", () => showAuth(customer ? "account" : "login"));
    // Links that switch views live in the dialog and in the checkout form.
    document.addEventListener("click", (e) => {
      const open = e.target.closest("[data-auth-open]");
      if (open) showAuth(open.dataset.authOpen);
    });
    $("[data-auth-close]").addEventListener("click", closeAuth);
    // Clicking the dimmed backdrop closes the dialog.
    dialog.addEventListener("click", (e) => { if (e.target === dialog) closeAuth(); });
    $$("form[data-auth-form]", dialog).forEach((form) => form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitAuth(form);
    }));
    $("[data-auth-logout]").addEventListener("click", signOut);

    // Password reset links look like /#reset=<token>.
    const match = /^#reset=([A-Za-z0-9_-]{32})$/.exec(location.hash);
    if (match) {
      resetToken = match[1];
      history.replaceState(null, "", location.pathname + location.search);
      showAuth("reset");
    }
  }

  /* ---------- Toast ---------- */

  let toastTimer;
  function toast(msg) {
    const el = $("[data-toast]");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const d = t.dataset;

      if (d.add) {
        setQty(d.add, 1);
        toast(productById.get(d.add).name + " added to cart");
      } else if (d.inc) {
        setQty(d.inc, (cart[d.inc] || 0) + 1);
      } else if (d.dec) {
        setQty(d.dec, (cart[d.dec] || 0) - 1);
      } else if (d.remove) {
        setQty(d.remove, 0);
      } else if ("cartClose" in d) {
        closeCart();
      } else if ("locate" in d) {
        requestLocation();
      } else if ("checkoutBtn" in d) {
        handleCheckout();
      } else if ("clearCart" in d) {
        cart = {};
        saveCart();
        renderCart();
        renderProductButtons();
      } else if ("category" in d) {
        filters.category = d.category;
        $$("[data-category]").forEach((c) => c.setAttribute("aria-pressed", String(c === t)));
        renderProducts();
      } else if (t.classList.contains("cart-toggle")) {
        openCart();
      }
    });

    // Image errors don't bubble, so listen in the capture phase.
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.dataset.fallback) img.outerHTML = img.dataset.fallback;
    }, true);

    $("[data-overlay]").addEventListener("click", closeCart);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#cart").classList.contains("open") && !$("[data-auth]").open) closeCart();
    });

    $("[data-search]").addEventListener("input", (e) => {
      filters.search = e.target.value;
      renderProducts();
    });
    $("[data-origin-filter]").addEventListener("change", (e) => {
      filters.origin = e.target.value;
      renderProducts();
    });
    $("[data-checkout]").addEventListener("input", () => {
      $("[data-form-error]").hidden = true;
    });
    $("[data-checkout]").addEventListener("submit", (e) => {
      e.preventDefault();
      handleCheckout();
    });
  }

  /* ---------- Hero carousel ---------- */

  function initCarousel() {
    // Products marked "Show in homepage slider" in the admin panel.
    const slides = products.filter((p) => p.featured && photoSrc(p));
    const root = $("[data-carousel]");
    if (!slides.length) { root.hidden = true; return; }

    $("[data-slides]").innerHTML = slides
      .map((p, i) => `
        <figure class="slide${i === 0 ? " active" : ""}" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}" aria-hidden="${i !== 0}">
          <img src="${escapeHtml(photoSrc(p))}" alt="${escapeHtml(p.name)}"${i === 0 ? "" : ' loading="lazy"'}>
          <figcaption>
            <p class="slide-name">${escapeHtml(p.name)}</p>
            <p class="slide-origin">${FLAGS[p.origin] || "🌍"} Imported from ${escapeHtml(p.origin)}</p>
          </figcaption>
        </figure>`)
      .join("");
    $("[data-dots]").innerHTML = slides
      .map((p, i) => `<button type="button" data-dot="${i}" aria-label="Show ${escapeHtml(p.name)}" aria-current="${i === 0}"></button>`)
      .join("");

    const figs = $$(".slide", root);
    const dots = $$("[data-dot]", root);
    let current = 0;
    let timer = null;

    function show(i) {
      current = (i + figs.length) % figs.length;
      const len = figs.length;
      figs.forEach((f, n) => {
        // Shortest signed distance around the loop, so cards wrap both ways.
        let d = (n - current + len) % len;
        if (d > len / 2) d -= len;
        f.style.setProperty("--d", d);
        f.style.setProperty("--abs", Math.abs(d));
        f.classList.toggle("active", d === 0);
        f.classList.toggle("far", Math.abs(d) > 2);
        f.classList.toggle("second", Math.abs(d) === 2);
        f.setAttribute("aria-hidden", String(d !== 0));
      });
      dots.forEach((d, n) => d.setAttribute("aria-current", String(n === current)));
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function start() {
      stop();
      if (!reduceMotion) timer = setInterval(() => show(current + 1), 4000);
    }
    function stop() { clearInterval(timer); }

    // Clicking a side card brings it to the front.
    figs.forEach((f, n) => f.addEventListener("click", () => { if (n !== current) { show(n); start(); } }));
    show(0);

    $("[data-slide-prev]").addEventListener("click", () => { show(current - 1); start(); });
    $("[data-slide-next]").addEventListener("click", () => { show(current + 1); start(); });
    dots.forEach((d) => d.addEventListener("click", () => { show(Number(d.dataset.dot)); start(); }));
    root.addEventListener("mouseenter", stop);
    root.addEventListener("mouseleave", start);
    root.addEventListener("focusin", stop);
    root.addEventListener("focusout", start);
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
    start();
  }

  /* ---------- Init ---------- */

  applyBranding();
  $("[data-moq-note]").textContent = moqMessage();
  renderFilters();
  renderProducts();
  renderCredits();
  initCarousel();
  renderCart();
  bindEvents();
  bindAccountEvents();
  loadAccount();
})();
