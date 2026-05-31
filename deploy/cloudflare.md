# Deploy BUIDLai to Cloudflare Pages

The Node server (`server.mjs`) is replaced on Cloudflare by **Pages Functions**:

- `functions/api/[[path]].js` — reverse-proxies `/api/*` → `TIPTAG_API_BASE`
  (default `https://bsc-api.tagai.fun`), forwarding `AccessToken` / `Authorization`.
- `functions/atoc-data.js` — same-origin proxy for the ATOC dashboard JSON, cached
  at the edge (Cache API) instead of server.mjs's in-process cache.
- `public/_redirects` — SPA fallback (`/* → /index.html 200`).
- `wrangler.toml` — `pages_build_output_dir = public`, plus non-secret `[vars]`
  (`TIPTAG_API_BASE`, `ATOC_DATA_URL`).

Static assets are served straight from `public/` (no build step for the app).

## One-time auth

Pick one:

```bash
# A) interactive OAuth (opens a browser)
npx wrangler login

# B) API token (no browser) — create a token with the "Cloudflare Pages: Edit"
#    permission at https://dash.cloudflare.com/profile/api-tokens
export CLOUDFLARE_API_TOKEN=xxxxxxxx
export CLOUDFLARE_ACCOUNT_ID=xxxxxxxx   # optional; needed if the token sees >1 account
```

## Deploy

```bash
npm run deploy:cf
# = wrangler pages deploy public --project-name=buidlai --commit-dirty=true
```

First deploy creates the `buidlai` Pages project. Note the `*.pages.dev` URL it
prints.

## Custom domain (buidlai.online)

DNS is already configured. In the Cloudflare dashboard → Pages → **buidlai** →
Custom domains → add `buidlai.online` (and `www`). Cloudflare provisions TLS
automatically. If the zone isn't on Cloudflare, add the `CNAME`/records it shows.

## Privy login (production)

`public/privy-adapter.js` is built with `localhost:5173/callback`. For prod login,
register `https://buidlai.online/callback` in the Privy dashboard, then rebuild:

```bash
VITE_APP_PRIVY_APP_ID=... VITE_APP_PRIVY_CLIENT_ID=... \
VITE_APP_PRIVY_REDIRECT_URI=https://buidlai.online/callback \
VITE_APP_PRIVY_LOGIN_REDIRECT_URI=https://buidlai.online/callback \
npm run build:privy && npm run deploy:cf
```

## Security notes

- `.env` is git-ignored and lives at repo root — it is **not** in `public/`, so it
  is never uploaded. `[vars]` in `wrangler.toml` are public API base URLs only.
- The `/api` proxy forwards the client `AccessToken`; no secrets are added server-side.
