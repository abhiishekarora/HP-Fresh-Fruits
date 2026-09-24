(function () {
  "use strict";

  const config = window.SITE_CONFIG;
  const products = window.PRODUCTS;
  const productById = new Map(products.map((p) => [p.id, p]));
  const CART_KEY = "fruit-shop-cart";

  const FLAGS = {
    "Australia": "🇦🇺", "China": "🇨🇳", "Egypt": "🇪🇬", "Japan": "🇯🇵",
    "Kenya": "🇰🇪", "Malaysia": "🇲🇾", "Mexico": "🇲🇽", "New Zealand": "🇳🇿",
    "Peru": "🇵🇪", "South Africa": "🇿🇦", "South Korea": "🇰🇷", "Thailand": "🇹🇭",
    "USA": "🇺🇸", "Vietnam": "🇻🇳",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
    $$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
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
        Object.entries(saved).filter(([id, qty]) => productById.has(id) && qty > 0)
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
    Object.entries(cart).reduce((sum, [id, qty]) => sum + productById.get(id).price * qty, 0);

  /* ---------- Product grid ---------- */

  const filters = { search: "", origin: "", category: "" };

  // Illustrations (SVG) are shown contained; photos fill the card.
  function mediaHtml(p, alt) {
    if (!p.image) return `<span class="product-emoji" aria-hidden="true">${p.emoji}</span>`;
    const cls = /\.svg$/i.test(p.image) ? "illustration" : "photo";
    return `<img class="${cls}" src="${escapeHtml(p.image)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  }

  function productCard(p) {
    const media = mediaHtml(p, p.name);
    return `
      <article class="product-card" data-id="${p.id}">
        <div class="product-media" style="background:${p.tint}">
          ${media}
          <span class="origin-badge">${FLAGS[p.origin] || "🌍"} ${escapeHtml(p.origin)}</span>
        </div>
        <div class="product-info">
          <p class="product-category">${escapeHtml(p.category)}</p>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="product-desc">${escapeHtml(p.description)}</p>
          <p class="product-price">${money.format(p.price)} <span>/ ${escapeHtml(p.unit)}</span></p>
        </div>
        <div class="product-action" data-action></div>
      </article>`;
  }

  function actionHtml(id) {
    const qty = cart[id] || 0;
    if (!qty) {
      return `<button class="btn btn-primary btn-block" type="button" data-add="${id}">Add to Cart</button>`;
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

    $("[data-origin-list]").innerHTML = origins
      .map((o) => {
        const names = products.filter((p) => p.origin === o).map((p) => p.name).join(", ");
        return `<li><button type="button" data-origin-pick="${escapeHtml(o)}"><span class="flag">${FLAGS[o] || "🌍"}</span><strong>${escapeHtml(o)}</strong><span class="muted small">${escapeHtml(names)}</span></button></li>`;
      })
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
            <span class="cart-thumb" style="background:${p.tint}" aria-hidden="true">${mediaHtml(p, "")}</span>
            <div class="cart-item-info">
              <p class="cart-item-name">${escapeHtml(p.name)}</p>
              <p class="muted small">${FLAGS[p.origin] || ""} ${escapeHtml(p.origin)} · ${money.format(p.price)} / ${escapeHtml(p.unit)}</p>
              <div class="qty-control qty-sm" role="group" aria-label="Quantity for ${escapeHtml(p.name)}">
                <button type="button" data-dec="${id}" aria-label="Decrease quantity">−</button>
                <span>${qty}</span>
                <button type="button" data-inc="${id}" aria-label="Increase quantity">+</button>
              </div>
            </div>
            <div class="cart-item-end">
              <strong>${money.format(p.price * qty)}</strong>
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

    $("[data-cart-subtotal]").textContent = money.format(cartSubtotal());
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

  /* ---------- Checkout ---------- */

  function handleCheckout() {
    const form = $("[data-checkout]");
    const btn = $("[data-checkout-btn]");
    const error = $("[data-form-error]");

    if (form.hidden) {
      form.hidden = false;
      btn.textContent = "Place order";
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
      error.textContent = "Please fill in your name, phone and address.";
      error.hidden = false;
      const firstInvalid = $$(":invalid", form)[0];
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    // No backend yet: the order is only confirmed on screen.
    // Hook an API call / WhatsApp / email integration in here.
    const order = {
      customer: Object.fromEntries(new FormData(form)),
      items: Object.entries(cart).map(([id, qty]) => ({ id, qty, price: productById.get(id).price })),
      subtotal: cartSubtotal(),
      placedAt: new Date().toISOString(),
    };
    console.info("Order placed", order);

    error.hidden = true;
    form.reset();
    form.hidden = true;
    btn.textContent = "Checkout";
    cart = {};
    saveCart();
    $("[data-success]").hidden = false;
    renderCart();
    renderProductButtons();
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
      } else if (d.originPick) {
        filters.origin = d.originPick;
        $("[data-origin-filter]").value = d.originPick;
        renderProducts();
        $("#shop").scrollIntoView({ behavior: "smooth" });
      } else if (t.classList.contains("cart-toggle")) {
        openCart();
      }
    });

    $("[data-overlay]").addEventListener("click", closeCart);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#cart").classList.contains("open")) closeCart();
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

  /* ---------- Init ---------- */

  applyBranding();
  $("[data-moq-note]").textContent = moqMessage();
  renderFilters();
  renderProducts();
  renderCart();
  bindEvents();
})();
