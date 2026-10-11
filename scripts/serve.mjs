import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const at = args.indexOf(key);
  return at < 0 ? fallback : args[at + 1];
};
const port = Number(option("--port", "0"));
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Use --port 0 or a port between 1 and 65535.");
const defaultRoot = existsSync(path.join(here, "app"))
  ? path.join(here, "app")
  : path.join(here, "../dist");
const root = await realpath(path.resolve(option("--root", defaultRoot)));
const mount = option("--mount", "/");
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(mount))
  throw new Error("Mount must be a slash-delimited path.");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt; charset=utf-8",
  ".zip": "application/zip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = http.createServer(async (req, res) => {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  };
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, headers);
      res.end("Method not allowed");
      return;
    }
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    if (
      raw.includes("\0") ||
      raw.includes("\\") ||
      raw.split("/").some((s) => s === ".." || s === ".") ||
      !raw.startsWith(mount)
    ) {
      res.writeHead(400, headers);
      res.end("Unsafe path");
      return;
    }
    let relative = raw.slice(mount.length);
    if (!relative || relative.endsWith("/")) relative += "index.html";
    const requested = path.resolve(root, relative);
    if (!requested.startsWith(root + path.sep)) {
      res.writeHead(403, headers);
      res.end("Outside app");
      return;
    }
    const resolved = await realpath(requested);
    if (
      !resolved.startsWith(root + path.sep) ||
      (await stat(resolved)).isDirectory()
    ) {
      res.writeHead(403, headers);
      res.end("Outside app");
      return;
    }
    const bytes = await readFile(resolved);
    res.writeHead(200, {
      ...headers,
      "Content-Type":
        types[path.extname(resolved)] || "application/octet-stream",
      "Content-Length": bytes.length,
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 404, headers);
    res.end("File not found");
  }
});
server.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}${mount}`,
      host: "127.0.0.1",
      port: address.port,
    }),
  );
});
const stop = () =>
  server.close(() => {
    process.exitCode = 0;
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
