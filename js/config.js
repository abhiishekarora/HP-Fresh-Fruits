/*
 * Site-wide settings. The business is due to be rebranded, so every place
 * the brand appears on the site reads from here — change it once and the
 * whole site updates.
 */
window.SITE_CONFIG = {
  brand: {
    name: "HP Fresh Fruits",
    tagline: "Exotic fruits, imported fresh from around the world",
    email: "orders@example.com",
    phone: "+91 00000 00000",
  },

  currency: { code: "INR", locale: "en-IN" },

  // Minimum order quantity has not been decided yet.
  // Set `value` to a number (e.g. 5) to enforce it at checkout;
  // `unit` is "items" (total units in cart) or "amount" (cart value).
  minOrder: {
    value: null,
    unit: "items",
    pendingMessage: "Minimum order quantity will be announced soon.",
  },
};
