// A tiny static file server for tests, screenshots and asset rendering. Not used by the live site.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

/** Serves `root` on 127.0.0.1 at a random free port (or `port`). Unknown paths get 404.html, like GitHub Pages. */
export async function startServer(root = ROOT, port = 0) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.join(root, rel), status = 200;
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { file = path.join(root, "404.html"); status = 404; }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(status, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}
