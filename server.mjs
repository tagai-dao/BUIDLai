import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 5173);
const apiBase = process.env.TIPTAG_API_BASE || "http://127.0.0.1:3000";

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
  serveStatic(req, res);
}).listen(port, () => {
  console.log(`BUIDLai UI running at http://localhost:${port}`);
  console.log(`Proxying /api to ${apiBase}`);
});
