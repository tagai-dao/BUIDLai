/**
 * BUIDLai Cloudflare Worker
 *
 * Replicates server.mjs behaviour on the edge:
 *   - /api/*      → reverse-proxy to TIPTAG_API_BASE (tiptag-api)
 *   - /atoc-data  → reverse-proxy to ATOC_DATA_URL, edge-cached 60 s
 *   - everything else → static asset from the Assets binding, with
 *                       SPA fallback to /index.html
 *
 * Env vars (set in wrangler.toml [vars] or the dashboard):
 *   TIPTAG_API_BASE  default: https://bsc-api.tagai.fun
 *   ATOC_DATA_URL    default: https://atocdashboard.tagclaw.com/data/dashboard-data.json
 */

const ATOC_TTL = 60; // seconds

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── canonical host: redirect www → apex (keeps one canonical URL) ─────────
    if (url.hostname === "www.buidlai.online") {
      url.hostname = "buidlai.online";
      return Response.redirect(url.toString(), 301);
    }

    // ── /api/* ──────────────────────────────────────────────────────────────
    if (path.startsWith("/api/")) {
      return proxyApi(request, url, env);
    }

    // ── /atoc-data ──────────────────────────────────────────────────────────
    if (path === "/atoc-data") {
      return proxyAtocData(request, env);
    }

    // ── static assets + SPA fallback ────────────────────────────────────────
    return serveAsset(request, env);
  }
};

// ── /api/* proxy ────────────────────────────────────────────────────────────
async function proxyApi(request, url, env) {
  const apiBase = (env.TIPTAG_API_BASE || "https://bsc-api.tagai.fun").replace(/\/$/, "");
  // Strip the leading /api prefix, keep the rest of the path + query string.
  const tail = url.pathname.replace(/^\/api/, "") + url.search;
  const target = apiBase + tail;

  const isBodyless = request.method === "GET" || request.method === "HEAD";
  const accessToken = request.headers.get("accesstoken");
  const authorization = request.headers.get("authorization");

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        accept: request.headers.get("accept") || "application/json",
        "content-type": request.headers.get("content-type") || "application/json",
        ...(accessToken  ? { AccessToken:   accessToken  } : {}),
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: isBodyless ? undefined : request.body,
      ...(isBodyless ? {} : { duplex: "half" })
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      }
    });
  } catch (err) {
    return jsonError(502, "TIPTAG_API_UNAVAILABLE", err.message);
  }
}

// ── /atoc-data proxy (edge-cached) ──────────────────────────────────────────
async function proxyAtocData(request, env) {
  const atocUrl = env.ATOC_DATA_URL ||
    "https://atocdashboard.tagclaw.com/data/dashboard-data.json";

  // Use the Cloudflare Cache API for a 60-second edge cache.
  const cacheKey = new Request("https://buidlai-atoc-cache.internal/data", { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-atoc-cache", "hit");
    return res;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(atocUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      clearTimeout(timer);
      const body = await upstream.arrayBuffer();
      if (upstream.ok && body.byteLength > 0) {
        const res = new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${ATOC_TTL}`,
            "x-atoc-cache": "miss"
          }
        });
        // Store in edge cache (fire-and-forget).
        cache.put(cacheKey, res.clone());
        return res;
      }
    } catch (_) { /* retry */ }
  }

  return jsonError(502, "ATOC_DATA_UNAVAILABLE", "Unable to reach atoc dashboard");
}

// ── static assets + SPA fallback ────────────────────────────────────────────
async function serveAsset(request, env) {
  // env.ASSETS is the static-asset binding declared in wrangler.toml.
  try {
    // Try the exact path first.
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;
  } catch (_) {}

  // SPA fallback: any unmatched path → /index.html (mirrors server.mjs).
  try {
    const indexUrl = new URL("/index.html", request.url);
    return await env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  } catch (err) {
    return new Response("Not found", { status: 404 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
