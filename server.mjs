import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

// CA guard: Homebrew's Node ships an incomplete root-CA store (missing GlobalSign
// Root CA), so the /atoc-data proxy's outbound HTTPS fetch fails. If NODE_EXTRA_CA_CERTS
// isn't set, re-exec once with a complete bundle. (See tiptag-api/bin/www for the same.)
if (process.env.__BUIDLAI_CA_REEXEC !== "1"
  && !(process.env.NODE_EXTRA_CA_CERTS && existsSync(process.env.NODE_EXTRA_CA_CERTS))) {
  const ca = ["/etc/ssl/cert.pem", "/opt/homebrew/etc/ca-certificates/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"].find((p) => {
    try { return existsSync(p); } catch { return false; }
  });
  if (ca) {
    const child = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, __BUIDLAI_CA_REEXEC: "1" }
    });
    process.exit(child.status == null ? 1 : child.status);
  }
}

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 5173);
const apiBase = process.env.TIPTAG_API_BASE || "http://127.0.0.1:3000";
// ATOC Agent dashboard data (no CORS on the upstream — proxy it same-origin).
const atocDataUrl = process.env.ATOC_DATA_URL || "https://atocdashboard.tagclaw.com/data/dashboard-data.json";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function proxyApi(req, res) {
  const targetPath = req.url.replace(/^\/api/, "");
  const target = new URL(targetPath, apiBase);
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const requestBody = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        accept: req.headers.accept || "application/json",
        "content-type": req.headers["content-type"] || "application/json",
        ...(req.headers.accesstoken ? { AccessToken: req.headers.accesstoken } : {}),
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : requestBody
    });
    const upstreamBody = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(Buffer.from(upstreamBody));
  } catch (error) {
    sendJson(res, 502, {
      error: "TIPTAG_API_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Unable to reach tiptag-api"
    });
  }
}

// Cache the upstream dashboard JSON so the page is fast and survives the upstream
// being slow/flaky (it's a 300KB cross-network HTTPS fetch with no CORS/caching).
const ATOC_TTL_MS = 60_000;
let atocCache = null; // { body: Buffer, at: number }

async function fetchAtocOnce(timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(atocDataUrl, { headers: { accept: "application/json" }, signal: controller.signal });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok && body.length > 0) atocCache = { body, at: Date.now() };
    return { ok: upstream.ok, status: upstream.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function proxyAtocData(req, res) {
  const send = (body, extra = {}) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
    res.end(body);
  };
  // Serve a fresh cache hit immediately.
  if (atocCache && Date.now() - atocCache.at < ATOC_TTL_MS) {
    send(atocCache.body, { "x-atoc-cache": "hit" });
    return;
  }
  // Try the upstream (one retry), fall back to stale cache, then error.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await fetchAtocOnce();
      if (result.ok && result.body.length > 0) { send(result.body, { "x-atoc-cache": "miss" }); return; }
    } catch (_) { /* try again / fall through */ }
  }
  if (atocCache) { send(atocCache.body, { "x-atoc-cache": "stale" }); return; }
  sendJson(res, 502, { error: "ATOC_DATA_UNAVAILABLE", message: "Unable to reach atoc dashboard" });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, requested));
  if (!relative(root, filePath) || relative(root, filePath).startsWith("..")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }
    res.writeHead(200, {
      "content-type": mime[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = join(root, "index.html");
    res.writeHead(200, {
      "content-type": mime[".html"],
      "cache-control": "no-cache"
    });
    res.end(await readFile(fallback));
  }
}

createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    proxyApi(req, res);
    return;
  }
  if (req.url.split("?")[0] === "/atoc-data") {
    proxyAtocData(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(port, () => {
  console.log(`BUIDLai UI running at http://localhost:${port}`);
  console.log(`Proxying /api to ${apiBase}`);
  // Warm the ATOC data cache so the first /atoc visit is instant, and refresh it
  // in the background so the page is never blocked on the slow upstream.
  const warm = () => fetchAtocOnce().catch(() => {});
  warm();
  setInterval(warm, ATOC_TTL_MS);
});
