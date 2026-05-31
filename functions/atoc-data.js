// Cloudflare Pages Function: same-origin proxy for the ATOC dashboard JSON.
// The upstream has no CORS and is a slow ~300KB cross-network fetch, so server.mjs
// proxied + cached it. Pages Functions are stateless, so we use the Cloudflare
// Cache API (edge cache) instead of the in-process cache from server.mjs.
const ATOC_TTL_SECONDS = 60;

export const onRequest = async (context) => {
  const { request, env } = context;
  const atocDataUrl =
    env.ATOC_DATA_URL || "https://atocdashboard.tagclaw.com/data/dashboard-data.json";

  // Stable cache key (ignore query string / method specifics).
  const cacheKey = new Request(new URL("/atoc-data", request.url).toString(), { method: "GET" });
  const cache = caches.default;

  // Fresh edge-cache hit → serve immediately.
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set("x-atoc-cache", "hit");
    return res;
  }

  // Try upstream (one retry).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(atocDataUrl, {
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
            "cache-control": `public, max-age=${ATOC_TTL_SECONDS}`,
            "x-atoc-cache": "miss"
          }
        });
        // Store a cacheable copy at the edge.
        context.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
    } catch (_) {
      /* retry / fall through */
    }
  }

  return new Response(
    JSON.stringify({ error: "ATOC_DATA_UNAVAILABLE", message: "Unable to reach atoc dashboard" }),
    { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
  );
};
