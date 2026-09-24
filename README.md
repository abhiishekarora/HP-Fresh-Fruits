# HP Fresh Fruits

A lightweight, light-themed storefront for ordering exotic, imported fruits.
Plain HTML/CSS/JS with no build step: open `index.html` in a browser, or host the
folder on any static host (GitHub Pages, Netlify, etc.).

## Features
- Product grid with country-of-origin badges, category chips, country filter and search
- **Add to Cart** button under every product, switching to a quantity stepper once added
- Slide-out cart: change quantities, remove items, subtotal, clear cart, checkout form
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
| Product photos | set `image: "images/your-photo.jpg"` on a product |
| Colours and fonts | CSS variables at the top of `css/styles.css` |

When `minOrder.value` is set (e.g. `5` items, or `unit: "amount"` for a minimum cart
value), the cart shows how much more is needed and blocks checkout until it's met.

The brand name is also hardcoded in the `<title>` and a few text fallbacks in
`index.html`; they get replaced at load time from `config.js`, but update them too
for search engines.

## Orders
There is no backend yet. Checkout validates the delivery details, shows a
confirmation and logs the order to the browser console. Connect it to an order API,
email or WhatsApp in `handleCheckout()` in `js/app.js`.
