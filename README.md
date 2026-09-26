# HP Fresh Fruits

A light-themed online shop for exotic, imported fruits, with a separate admin panel.
Both run on Cloudflare Workers (free plan), each with its own backend.

## How it's organised

```
shop/        storefront pages (HTML/CSS/JS)             → yourdomain.com
shop-api/    storefront backend (Cloudflare Worker)     → same domain: /api, /photos, /internal
admin/       admin panel pages (HTML/CSS/JS)            → admin.yourdomain.com
admin-api/   admin backend (Cloudflare Worker)          → same subdomain: /api, /preview
```

```
 customer ──► shop/ ──(/api/catalog)──► shop-api ──► KV storage (products, settings, photos)
                                            ▲
 owner ──► admin/ ──(/api/...)──► admin-api ┘  private API (/internal/*),
                                               service binding + shared INTERNAL_API_KEY
```

- **shop-api** owns the data. It serves the public catalogue to the shop and a private
  API that only the admin backend can use. Until the first save from the admin panel,
  the catalogue comes from the bundled `shop/data/*.json`.
- **admin-api** stores nothing. It handles the admin password login and forwards
  every read and change to shop-api's private API.

## Features
- Product grid with country-of-origin badges, category chips, country filter and search
- **Add to Cart** under every product, with a quantity stepper once added
- Slide-out cart with checkout; orders are sent to your WhatsApp (see below)
- Checkout asks for the customer's precise location and adds a map link to the order
- 3D photo carousel of featured fruits on the homepage
- Stock labels (limited, new arrival, sold out); sold-out fruits can't be ordered
- Admin panel: add, edit, hide, reorder and delete products; upload photos; change
  prices, stock, homepage text, WhatsApp number, minimum order and currency

## Going online (Cloudflare)
You create **two Workers** from this repository, one per backend. Deploy the shop first,
because the admin backend connects to it by name.

### 1. Storefront (`fruit-shop`)
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**, pick this repo.
2. Settings:
   - **Project name:** `fruit-shop` (must match `name` in `shop-api/wrangler.jsonc`)
   - **Root directory:** `shop-api`
   - **Build command:** empty · **Deploy command:** `npx wrangler deploy`
3. Deploy. The first deploy also creates the KV storage for products and photos.
4. **Settings → Variables and Secrets → Add**: `INTERNAL_API_KEY` (type **Secret**), a long
   random value (at least 16 characters, e.g. from a password generator). Redeploy.
5. **Settings → Domains & Routes → Add → Custom domain**: `yourdomain.com` (optional; the
   `workers.dev` address works too).

### 2. Admin panel (`fruit-shop-admin`)
1. **Create → Import a repository** again, same repo.
2. Settings:
   - **Project name:** `fruit-shop-admin` (matches `admin-api/wrangler.jsonc`)
   - **Root directory:** `admin-api`
   - **Build command:** empty · **Deploy command:** `npx wrangler deploy`
3. Deploy, then **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `ADMIN_PASSWORD` | Secret | the password you'll log in with (make it long) |
   | `SESSION_SECRET` | Secret | another long random value |
   | `INTERNAL_API_KEY` | Secret | **exactly the same** value as on `fruit-shop` |
   | `SHOP_URL` | Text | the shop's address, e.g. `https://yourdomain.com` (for the "View shop" link) |

   Redeploy.
4. **Settings → Domains & Routes → Add → Custom domain**: `admin.yourdomain.com`.
5. Open the admin address and log in with `ADMIN_PASSWORD`.

**Recommended extra protection:** put the admin subdomain behind **Cloudflare Access**
(Zero Trust → Access → Applications → Add → Self-hosted, domain `admin.yourdomain.com`,
allow only your email). It's free for small teams and adds an email one-time-code check
before anyone even sees the login page.

If the first deploy of `fruit-shop` complains about the KV namespace, create one under
**Storage & Databases → KV → Create** and add its id to `shop-api/wrangler.jsonc`:
`"kv_namespaces": [{ "binding": "SHOP_DATA", "id": "<namespace id>" }]`.

Every push to the connected branch redeploys both Workers automatically.

## Using the admin panel
- **Products:** click **Edit** to change a product, **+ Add product** for a new one, ↑/↓ to
  reorder. Changes stay in the panel until you click **Save changes**.
- **Photos:** in a product, **Upload photo** (JPG, PNG, WebP; up to 5 MB). Landscape
  photos (about 4:3) fit the cards best.
- **Settings:** business details, homepage heading, WhatsApp number, delivery note,
  minimum order and currency. Click **Save settings**.

The shop shows changes within about a minute.

## Orders
Checkout sends the order to your WhatsApp. WhatsApp opens with the full order already
written (items, quantities, total, name, phone, address and a map link); the customer
presses send and it arrives on your number. Set the number in the admin panel under
**Settings → Orders** (country code, digits only, e.g. `919876543210`). While it's empty,
checkout only shows an on-screen confirmation.

Browsers only allow location access on `https://` sites (or `localhost`).

## Running locally
With Node.js installed:

```
cd shop-api && npx wrangler dev --port 8787
# in a second terminal
cd admin-api && npx wrangler dev --port 8788
```

Put local secrets in `shop-api/.dev.vars` and `admin-api/.dev.vars` (one `NAME=value` per
line; these files are git-ignored), then open http://localhost:8787 (shop) and
http://localhost:8788 (admin).

## Photos
Some bundled product photos come from Wikimedia Commons under their free licences
(mostly Creative Commons Attribution-ShareAlike). The shop footer's "Photo credits"
list links each photo's source page, which names the photographer and licence.
If a photo can't load, the product falls back to its illustration or emoji.

## License
Proprietary (excluding third-party photos, which keep their own licences). Copyright (c) 2026 HP Fresh Fruits. All rights reserved.
No use, copying or distribution without written permission. See [LICENSE](LICENSE).
