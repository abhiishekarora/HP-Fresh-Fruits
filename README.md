# HP Fresh Fruits

A lightweight, light-themed storefront for ordering exotic, imported fruits.
Plain HTML/CSS/JS with no build step. Products and settings live in `data/*.json`
(edited through the admin panel), so the site must be served over HTTP; opening
`index.html` straight from disk won't load them. Any static host works.

## Features
- Product grid with country-of-origin badges, category chips, country filter and search
- **Add to Cart** button under every product, switching to a quantity stepper once added
- Slide-out cart: change quantities, remove items, subtotal, clear cart, checkout form
- Checkout asks for the customer's precise current location (browser GPS, high accuracy) and
  attaches the coordinates and a map link to the order; the typed address remains the fallback
- Cart is saved in the browser (`localStorage`), so it survives a page reload
- "Origins" section listing every source country; click one to filter the shop
- Responsive layout for phones and desktops

## Admin panel (change the shop without touching code)
Go to `/admin` on the live site (e.g. `https://your-site.netlify.app/admin`) and log in
with GitHub. From there you can:

- **Products:** add, remove and reorder fruits; change names, prices, pack sizes,
  categories, countries, descriptions and photos (upload straight from your phone or
  computer); mark them *In stock*, *Limited stock*, *New arrival* or *Sold out*; hide
  them from the site; and choose which ones appear in the homepage slider.
- **Settings:** business name, tagline, email, phone, homepage heading, WhatsApp
  number for orders, delivery note, minimum order and currency.

Every save is stored in this repository (`data/products.json`, `data/settings.json`,
photos in `images/photos/`), and the host republishes the site automatically, usually
within a minute.

### One-time setup (after the site is on Netlify)
The admin panel logs in through GitHub, so it needs a GitHub "OAuth app":

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.
   - Homepage URL: your site address, e.g. `https://your-site.netlify.app`
   - Authorization callback URL: `https://api.netlify.com/auth/done`
   - Click **Register**, then **Generate a new client secret**.
2. On Netlify: **Site configuration → Access & security → OAuth → Install provider →
   GitHub**, and paste the Client ID and Client secret.
3. Open `https://your-site.netlify.app/admin` and click **Login with GitHub**.

Only GitHub accounts that can push to this repository can save changes. To give
someone else access, add them as a collaborator on the repository.

If the site is later published from a different branch (e.g. `main`), change
`branch:` in `admin/config.yml` to match.

### Trying the admin panel on your computer
Run `npx decap-server` in the project folder and, in a second terminal, serve the
folder (e.g. `python3 -m http.server 8080`), then open `http://localhost:8080/admin`.
Changes are written straight to your local files.

## Orders
Checkout sends the order to your WhatsApp. When a customer places an order,
WhatsApp opens with the full order already written (items, quantities, total,
name, phone, address and a map link to their location). They press send and it
arrives on your number.

Set the number in the admin panel under **Settings → Orders**, digits only with the
country code (e.g. `919876543210`). While it's empty, checkout only shows an
on-screen confirmation.

Browsers only allow location access on `https://` sites (or `localhost`).

## Going online (Netlify, free)
1. Sign up at https://app.netlify.com with your GitHub account.
2. **Add new site → Import an existing project → GitHub**, and pick this repository
   (private repositories work). Choose the branch to publish.
3. Leave the build command empty; `netlify.toml` already sets everything.
4. Click **Deploy**. You get an `https://<name>.netlify.app` address straight away,
   and every push to the branch updates the site automatically.
5. Optional: **Domain management → Add a domain** to use your own web address.

## Photos
Product photos are loaded from Wikimedia Commons under their free licences
(mostly Creative Commons Attribution-ShareAlike). The footer's "Photo credits"
list links each photo's source page, which names the photographer and licence.
If a photo can't load, the product falls back to its illustration or emoji.

## License
Proprietary (excluding third-party photos, which keep their own licences). Copyright (c) 2026 HP Fresh Fruits. All rights reserved.
No use, copying or distribution without written permission. See [LICENSE](LICENSE).
