// PM2 process config for the BUIDLai static server (server.mjs).
// Mirrors the tiptag-api PM2 setup so the frontend runs the same way on the host.
//
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save
//
// Production env (override per-host as needed):
//   PORT             - port server.mjs listens on (nginx proxies 80 -> this)
//   TIPTAG_API_BASE  - backend base; prod is https://bsc-api.tagai.fun
module.exports = {
  apps: [
    {
      name: "buidlai-ui",
      script: "server.mjs",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      env: {
        PORT: 5173,
        TIPTAG_API_BASE: "http://127.0.0.1:3000"
      },
      env_production: {
        PORT: 5173,
        TIPTAG_API_BASE: "https://bsc-api.tagai.fun"
      }
    }
  ]
};
