# HP Fresh Fruits

A light-themed online shop for exotic, imported fruits, with a separate admin panel.
Both run on Cloudflare Workers (free plan), each with its own backend.

## How it's organised

```
/  (repository root)      the customer website, where people order fruits  → yourdomain.com
  index.html, css/, js/, images/, data/
  backend/index.js        the website's backend (Cloudflare Worker): /api, /photos, /internal
  wrangler.jsonc          deploys the website

admin/                    the admin panel, completely separate             → admin.yourdomain.com
  public/                 admin pages
  backend/index.js        admin backend (Cloudflare Worker): login, /api, /preview
  wrangler.jsonc          deploys the admin panel
```

```
 customer ──► website ──(/api/catalog)──► website backend ──► KV storage (products, settings, photos)
                                               ▲
 owner ──► admin pages ──(/api/...)──► admin backend ┘ private API (/internal/*),
                                                      service binding + shared INTERNAL_API_KEY
```

- The **website backend** owns the data. It serves the public catalogue to the website and
  a private API that only the admin backend can use. Until the first save from the admin
  panel, the catalogue comes from the bundled `data/*.json`.
- The **admin backend** stores nothing. It handles admin sign-in (Google or email + password) and forwards
  every read and change to the website backend's private API.
- Nothing from `admin/` or `backend/` is published on the customer website (see
  `.assetsignore`).

## Features
- Product grid with country-of-origin badges, category chips, country filter and search
- **Add to Cart** under every product, with a quantity stepper once added
- Slide-out cart checkout saves orders for the admin panel and opens WhatsApp for confirmation
- Customer email confirmations and order-status updates
- Checkout asks for the customer's precise location and adds a map link to the order
- 3D photo carousel of featured fruits on the homepage
- Stock labels (limited, new arrival, sold out); sold-out fruits can't be ordered
- Admin panel: add, edit, hide, reorder and delete products; upload photos; change
  prices, stock, homepage text, WhatsApp number, minimum order and currency
- Admin order queue with status updates and automatic two-minute refresh
- Customer accounts: register, sign in, password reset by email, and a "Your account"
  page with order history. Checkout fills in saved details; guests can still order.
- Admin **Reports** tab: download any month as an Excel workbook (summary, orders, order
  lines, product sales, daily sales, customers, new accounts, catalogue)

## Going online (Cloudflare)
You create **two Workers** from this repository, one per backend. Deploy the shop first,
because the admin backend connects to it by name.

### 1. Customer website (`hp-fresh-fruits`)
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**, pick this repo.
2. Settings:
   - **Project name:** `hp-fresh-fruits` (must match `name` in `wrangler.jsonc`)
   - **Root directory:** leave empty (the repository root)
   - **Build command:** empty · **Deploy command:** `npx wrangler deploy`
3. Deploy. The first deploy also creates the KV storage for products and photos.
4. **Settings → Variables and Secrets → Add**: `INTERNAL_API_KEY` (type **Secret**), a long
    random value (at least 16 characters, e.g. from a password generator). Use the same value
    on the admin Worker. Add customer email settings as described below.
5. **Settings → Domains & Routes → Add → Custom domain**: `yourdomain.com` (optional; the
   `workers.dev` address works too).

### Customer order emails
Order status emails use Resend. Verify a sending domain in Resend, then from the repository
root set `RESEND_API_KEY` as a secret and `ORDER_EMAIL_FROM` as the verified sender address
(for example, `HP Fresh Fruits <orders@yourdomain.com>`):

```
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ORDER_EMAIL_FROM
```

Orders are still saved if email delivery is not configured, but customers will not receive
confirmation or status updates until both settings are valid. Because checkout can send
email, configure a Cloudflare rate-limiting rule for the storefront's `/api/orders` route
before making the site public. Customer contact and delivery details are stored in the
storefront Worker's `SHOP_DATA` KV and visible only through the authenticated admin panel.

### 2. Admin panel (`hpadmin`)
1. **Create → Import a repository** again, same repo.
2. Settings:
   - **Project name:** `hpadmin` (matches `admin/wrangler.jsonc`)
   - **Root directory:** `admin`
   - **Build command:** empty · **Deploy command:** `npx wrangler deploy`
3. Deploy, then **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `ADMIN_EMAIL` | Secret | who may sign in; several addresses separated by commas |
   | `GOOGLE_CLIENT_ID` | Secret | from Google Cloud (see "Sign in with Google" below) |
   | `GOOGLE_CLIENT_SECRET` | Secret | from Google Cloud |
   | `ADMIN_PASSWORD` | Secret | optional: enables email + password sign-in as well |
    | `SESSION_SECRET` | Secret | at least 32 random characters |
   | `INTERNAL_API_KEY` | Secret | **exactly the same** value as on `hp-fresh-fruits` |
   | `SHOP_URL` | Text | the shop's address, e.g. `https://yourdomain.com` (for the "View shop" link) |

   Redeploy.
4. **Settings → Domains & Routes → Add → Custom domain**: `admin.yourdomain.com`.
5. Open the admin address and click **Sign in with Google** (or use email + password).

### Sign in with Google (one-time setup)
1. Go to https://console.cloud.google.com, create a project (e.g. "HP Fresh Fruits Admin").
2. **APIs & Services → OAuth consent screen**: user type **External**, app name, your email.
   Add your admin email(s) as **test users** (or publish the app).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorised redirect URI: `https://<your admin address>/api/oauth/google/callback`
     (e.g. `https://hpadmin.lazietech.workers.dev/api/oauth/google/callback`; add the
     custom-domain version too if you use one)
4. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` on the admin Worker.

Only Google accounts listed in `ADMIN_EMAIL` (with a verified email) get in. The admin
backend uses the authorization-code flow with PKCE and a one-time state check.

**Recommended extra protection:** put the admin subdomain behind **Cloudflare Access**
(Zero Trust → Access → Applications → Add → Self-hosted, domain `admin.yourdomain.com`,
allow only your email). It's free for small teams and adds an email one-time-code check
before anyone even sees the login page.

If the first deploy of `hp-fresh-fruits` complains about the KV namespace, create one under
**Storage & Databases → KV → Create** and add its id to `wrangler.jsonc`:
`"kv_namespaces": [{ "binding": "SHOP_DATA", "id": "<namespace id>" }]`.

Every push to the connected branch redeploys both Workers automatically.

## Security notes
- **Rate limits** (counted in the shop's KV): 10 orders per hour per connection;
  5 sign-ups per hour; 20 failed customer sign-ins per connection and 10 per account
  every 15 minutes; 5 failed admin password sign-ins per connection and 30 overall every
  15 minutes. KV is eventually consistent, so these are approximate. For hard limits, also
  add Cloudflare rate-limiting rules for `/api/orders`, `/api/auth/*` and the admin
  host's `/api/login`.
- **Customer passwords** are stored as salted PBKDF2-SHA256 hashes. Sessions are random
  tokens in an HttpOnly cookie, stored server-side, so signing out ends them. Resetting
  a password signs the account out everywhere.
- **Password reset** emails use the same Resend settings as order emails. Without them,
  the shop tells customers to contact you instead.
- Every `POST` to the shop's `/api/*` must come from the shop's own origin as JSON
  (blocks cross-site form posts). Uploaded photos are checked by their file contents,
  not by the type the browser claims.
- Account emails are not verified at sign-up, so an order's email address is only as
  reliable as what the customer typed.
- **KV usage:** each order, sign-up, sign-in and rate-limit counter is a KV write. The
  free plan allows 1,000 writes a day; a busy shop needs the Workers paid plan.
- The admin session is a signed 12-hour cookie. To sign out every admin session at
  once, change `SESSION_SECRET`.

## Using the admin panel
- **Products:** click **Edit** to change a product, **+ Add product** for a new one, ↑/↓ to
  reorder. Changes stay in the panel until you click **Save changes**.
- **Photos:** in a product, **Upload photo** (JPG, PNG, WebP; up to 5 MB). Landscape
  photos (about 4:3) fit the cards best.
- **Settings:** business details, homepage heading, WhatsApp number, delivery note,
  minimum order and currency. Click **Save settings**.

- **Reports:** pick a month and click **Download Excel report**. Months and times use
  your computer's time zone. Sales figures leave out cancelled orders; items without a
  price count as units but not sales. Up to 900 orders a month are included (the
  Summary sheet warns if a month has more). The file contains customer contact details.

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
npx wrangler dev --port 8787              # customer website, from the repository root
cd admin && npx wrangler dev --port 8788  # admin panel, in a second terminal
```

Put local secrets in `.dev.vars` (root) and `admin/.dev.vars` (one `NAME=value` per line;
these files are git-ignored), then open http://localhost:8787 (website) and
http://localhost:8788 (admin).

## Products and photos
The bundled catalogue (`data/products.json`, photos in `images/catalog/`) comes from the
HP Fresh catalogue: 30 fruits, each listed once per origin country (58 products).
Prices aren't in the catalogue, so products show **Price on request** until a price is
set in the admin panel. Items without a price are listed as "price on request" in the
WhatsApp order and left out of the subtotal.

Once anything is saved in the admin panel, the shop uses the saved catalogue instead of
the bundled file.

## License
Proprietary. Copyright (c) 2026 HP Fresh Fruits. All rights reserved.
No use, copying or distribution without written permission. See [LICENSE](LICENSE).
