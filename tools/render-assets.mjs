// Renders the social card and the PNG icons from the brand.   npm run assets
//   assets/og.png (1200x630), assets/apple-touch-icon.png (180x180), assets/favicon-32.png (32x32)
// The art lives in tools/og.html. assets/mark.svg is the vector favicon and needs no rendering.
import path from "node:path";
import puppeteer from "puppeteer-core";
import { startServer, ROOT, CHROME } from "./static-server.mjs";

const server = await startServer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 1000, deviceScaleFactor: 1 });
await page.goto(server.url + "/tools/og.html", { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
for (const [id, file] of [["og", "og.png"], ["icon180", "apple-touch-icon.png"], ["icon32", "favicon-32.png"]]) {
  await (await page.$("#" + id)).screenshot({ path: path.join(ROOT, "assets", file) });
  console.log("assets/" + file);
}
await browser.close();
await server.close();
