// Cloudflare Pages Function: reverse-proxy /api/* -> tiptag-api.
// Mirrors the proxyApi() logic in server.mjs (which Pages can't run since it's a
// Node http server). Forwards AccessToken / Authorization and the request body.
//
// Backend base is configurable via the TIPTAG_API_BASE environment variable
// (set in the Pages project settings / wrangler.toml). Defaults to prod.
export const onRequest = async (context) => {
  const { request, env, params } = context;
  const apiBase = env.TIPTAG_API_BASE || "https://bsc-api.tagai.fun";

  // params.path is the matched segments after /api/ (string or string[]).
  const tail = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
  const url = new URL(request.url);
  const target = new URL(tail + url.search, apiBase.endsWith("/") ? apiBase : apiBase + "/");

  const accessToken = request.headers.get("accesstoken");
  const authorization = request.headers.get("authorization");
  const isBodyless = request.method === "GET" || request.method === "HEAD";

  try {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers: {
        accept: request.headers.get("accept") || "application/json",
        "content-type": request.headers.get("content-type") || "application/json",
        ...(accessToken ? { AccessToken: accessToken } : {}),
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: isBodyless ? undefined : request.body,
      // Pages requires this when streaming a request body through.
      ...(isBodyless ? {} : { duplex: "half" })
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "TIPTAG_API_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Unable to reach tiptag-api"
      }),
      { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  }
};
