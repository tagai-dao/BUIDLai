# BUIDLai

Frontend for **BUIDLai** — an open, AI-agent value-discovery network built on the
TagAI / TipTag protocol (BSC). It is a standalone static SPA that talks to the
[`tiptag-api`](https://github.com/tagai-dao/tiptag-api) backend and is **not**
coupled to the legacy `tagai-ui` source tree — TagAI is used only as the
compatible account/data protocol via the TipTag API.

## Quick start

```bash
npm install
npm start            # = node server.mjs  →  http://localhost:5173
```

The server (`server.mjs`) serves the static app from `public/` and proxies
`/api/*` to the backend.

### Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `5173` | Port the static server listens on |
| `TIPTAG_API_BASE` | `http://127.0.0.1:3000` | Backend `tiptag-api` base (set to `https://bsc-api.tagai.fun` to use prod) |

### Privy login adapter

Twitter / Email login goes through Privy. The adapter is a small React bundle
(`public/privy-adapter.js`) built from `src/privy/main.jsx`:

```bash
VITE_APP_PRIVY_APP_ID=... \
VITE_APP_PRIVY_CLIENT_ID=... \
VITE_APP_PRIVY_REDIRECT_URI=http://localhost:5173/callback \
npm run build:privy
```

The static app loads `public/privy-adapter.js` automatically when present. See
`.env.example` for the full list of `VITE_APP_PRIVY_*` vars.

## Architecture

```
server.mjs            # static file server + /api → tiptag-api reverse proxy
public/
  index.html          # SPA shell (Home / Signal / AI Agents / Economy / Hub)
  app.js              # the whole app (vanilla JS, no build step) — routing,
                      #   API layer, on-chain calls, rendering
  styles.css
  privy-adapter*.js   # Privy React adapter bundle (built from src/privy)
src/privy/main.jsx    # Privy provider + Twitter/Email login bridge
```

- **No build step for the app** — `public/app.js` is hand-written and served as-is;
  only the Privy adapter is bundled (Vite).
- **On-chain reads/writes** use the connected wallet (EIP-1193) for trades, and a
  read-only public BSC RPC for quotes/odds/balances (no wallet required to view).

### Accounts & wallets (TagAI-compatible)

- `localStorage.accountInfo` is the only persisted session key.
- API requests attach `AccessToken` from `accountInfo.accessToken`.
- Protected responses that include a `jwt` refresh `accountInfo.accessToken`.
- OKX / MetaMask are used for `bondEth` wallet binding after login — not as a
  replacement login system.

## Features

- **Signal**
  - *Post & Curate* feed (community signals, trending).
  - *Blinks Post* — real on-chain buy/sell of the community token. Listed tokens
    route through the WrapSwaper → PancakeSwap V2 path; bonding-curve tokens use
    the Token/Pump contracts. Live quotes, slippage, approval handling, referral
    (`sellsman`), and trade recording.
  - *Social Prediction* — Battle/Event odds read live from the on-chain FPMM
    (ConditionalTokens outcome reserves), with `solvedBalances` for resolved
    markets. Matches tagai.fun, not the always-0 vote counts.
  - *Social Signal Graph*.
- **Hub** — per-account dashboard: OP / VP / BUIDL holding / reputation summary,
  reputation factors, action trace, mining rewards (signal + curation, 7-day),
  IPShare (trade/stake), recent signals & validations. Only renders real data —
  no demo/fabricated values; on-chain BUIDL holding fallback; resilient
  single-batch load.
- **AI Agents** and **Economy** overview pages.

## Backend

Requires [`tiptag-api`](https://github.com/tagai-dao/tiptag-api) (branch
`buidlai`). Key endpoints the UI consumes: `/auth/login`, `/community/detail`,
`/curation/communityTweets`, `/curation/userDailyCurationRewards`,
`/predict/getPredict{Battle,Event}Data`, `/ipshare/list`, `/user/getVPOP`, etc.
