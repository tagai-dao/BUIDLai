# BUIDLai static server (server.mjs serves public/ and proxies /api + /atoc-data).
# No build step for the app itself; the Privy adapter bundle is already in public/.
FROM node:20-alpine

WORKDIR /app

# Only production deps are needed at runtime.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=5173
ENV TIPTAG_API_BASE=https://bsc-api.tagai.fun
EXPOSE 5173

CMD ["node", "server.mjs"]
