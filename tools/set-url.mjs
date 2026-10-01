// Tells the site its public address, once you know it.
//   npm run set-url -- https://example.github.io/head-scratch-society/
//   npm run set-url -- --reset        (back to relative, address-free)
//
// Why: link previews on Facebook and friends only work when og:image and og:url are absolute URLs,
// and shared brags read better with the real address. This edits index.html in place:
//   SITE.url, og:url, og:image, twitter:image and <link rel="canonical">.
// Nothing is uploaded or deployed. A second argument can name a different file (used by the tests).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [arg, fileArg] = process.argv.slice(2);
const file = fileArg || path.join(ROOT, "index.html");
if (!arg) { console.error("Usage: npm run set-url -- https://your.site/path/   (or --reset)"); process.exit(1); }

let base = "";
if (arg !== "--reset") {
  let u;
  try { u = new URL(arg); } catch { console.error(`Not a URL: ${arg}`); process.exit(1); }
  if (u.protocol !== "https:") { console.error("Use an https:// address."); process.exit(1); }
  if (u.search || u.hash) { console.error("Leave out the query string and the # part."); process.exit(1); }
  base = u.origin + u.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
}

let html = fs.readFileSync(file, "utf8");
const swap = (re, to, what) => { if (!re.test(html)) { console.error(`Could not find ${what} in ${file}`); process.exit(1); } html = html.replace(re, to); };
const image = base + "assets/og.png";
swap(/(<meta property="og:image" content=")[^"]*(">)/, `$1${image}$2`, "og:image");
swap(/(<meta name="twitter:image" content=")[^"]*(">)/, `$1${image}$2`, "twitter:image");
swap(/(\n\s*url: ")[^"]*(")/, `$1${base}$2`, "SITE.url");
html = html.replace(/<link rel="canonical"[^>]*>\n/, "").replace(/<meta property="og:url"[^>]*>\n/, "");
if (base) swap(/(<meta property="og:type" content="website">\n)/, `<link rel="canonical" href="${base}">\n<meta property="og:url" content="${base}">\n$1`, "og:type");
fs.writeFileSync(file, html);
console.log(base ? `Site address set to ${base}` : "Site address cleared. All URLs are relative again.");
