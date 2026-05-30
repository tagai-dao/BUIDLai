# BUIDLai UI

Lightweight first pass for the BUIDLai product, built as a standalone app in this new `ui` folder.

This UI does not import or depend on the legacy `tagai-ui` source tree. TagAI is used only as the compatible account/data protocol through the TipTag API endpoints.

## Run

```bash
npm run dev
```

Open `http://localhost:5173`.

To enable the TagAI-compatible Privy login bridge, configure the same Privy env names used by TagAI and build the adapter:

```bash
VITE_APP_PRIVY_APP_ID=... \
VITE_APP_PRIVY_CLIENT_ID=... \
npm run build:privy
```

The build writes `public/privy-adapter.js`. The static app loads it automatically when present.

## Data

The local server proxies `/api/*` to `http://127.0.0.1:3000` by default, which is the local `tiptag-api` port from the checked-in `.env`. Set `TIPTAG_API_BASE=https://bsc-api.tagai.fun` if you want to point the UI at the production API instead:

- `/api/community/detail?tick=BUIDL`
- `/api/curation/communityTweets?tick=BUIDL&pages=0`
- `/api/ipshare/list?pages=0`

Set `TIPTAG_API_BASE=...` to point at another `tiptag-api` server.

## Wallets

The account module follows TagAI's account model:

- `localStorage.accountInfo` is the only persisted session key.
- API requests attach `AccessToken` from `accountInfo.accessToken`.
- Protected API responses that include `jwt` update `accountInfo.accessToken`.
- Twitter and Email login are provided by `src/privy/main.jsx`, which follows TagAI's Privy flow and calls `window.BUIDLaiAccount.completePrivyTwitterLogin(...)` or `window.BUIDLaiAccount.completePrivyEmailLogin(...)`.
- OKX / MetaMask are used for `bondEth` wallet binding after login, not as a replacement login system.
