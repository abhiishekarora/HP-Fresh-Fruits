# HP Fresh Fruits

A lightweight, light-themed storefront for ordering exotic, imported fruits.
Plain HTML/CSS/JS with no build step: open `index.html` in a browser, or host the
folder on any static host (GitHub Pages, Netlify, etc.).

## Features
- Product grid with country-of-origin badges, category chips, country filter and search
- **Add to Cart** button under every product, switching to a quantity stepper once added
- Slide-out cart: change quantities, remove items, subtotal, clear cart, checkout form
- Checkout asks for the customer's precise current location (browser GPS, high accuracy) and
  attaches the coordinates and a map link to the order; the typed address remains the fallback
- Cart is saved in the browser (`localStorage`), so it survives a page reload
- "Origins" section listing every source country; click one to filter the shop
- Responsive layout for phones and desktops

## Customising

| What | Where |
| --- | --- |
| Brand name, tagline, email, phone (for the upcoming rebrand) | `js/config.js` → `brand` |
| Minimum order quantity (currently "to be announced") | `js/config.js` → `minOrder.value` / `unit` |
| Currency | `js/config.js` → `currency` |
| Products, prices, origins, descriptions | `js/products.js` |
| Product photos | `photo` on each product in `js/products.js` (Wikimedia Commons by default; see `images/photos/README.md` to use your own) |
| Colours and fonts | CSS variables at the top of `css/styles.css` |

When `minOrder.value` is set (e.g. `5` items, or `unit: "amount"` for a minimum cart
value), the cart shows how much more is needed and blocks checkout until it's met.

The brand name is also hardcoded in the `<title>` and a few text fallbacks in
`index.html`; they get replaced at load time from `config.js`, but update them too
for search engines.

## Orders
There is no backend yet. Checkout validates the delivery details, shows a
confirmation and logs the order to the browser console. Connect it to an order API,
email or WhatsApp in `handleCheckout()` in `js/app.js`. The order includes `latitude`,
`longitude` and `locationAccuracy` (metres) when the customer shared their location.

Browsers only allow location access on `https://` sites (or `localhost`).

## Photos
Product photos are loaded from Wikimedia Commons under their free licences
(mostly Creative Commons Attribution-ShareAlike). The footer's "Photo credits"
list links each photo's source page, which names the photographer and licence.
If a photo can't load, the product falls back to its illustration or emoji.

## License
Proprietary (excluding third-party photos, which keep their own licences). Copyright (c) 2026 HP Fresh Fruits. All rights reserved.
No use, copying or distribution without written permission. See [LICENSE](LICENSE).
