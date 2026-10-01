// Full-page screenshots for a visual check.   npm run screens
// Writes screens/<theme>-<width>.png (light and dark, 390 and 1280 wide) plus viewport-sized slices
// in screens/parts/ and a few played states in screens/states/. The screens/ folder is gitignored.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { startServer, ROOT, CHROME } from "./static-server.mjs";

const OUT = path.join(ROOT, "screens");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "parts"), { recursive: true });
fs.mkdirSync(path.join(OUT, "states"), { recursive: true });

const server = await startServer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const only = process.argv[2];                       // optional: "pages" or "states"

async function open(theme, width, height = 900, query = "?date=2026-10-05") {
  const context = await browser.createBrowserContext();   // a clean slate: nothing remembered from the last shot
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: width < 600 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(server.url + "/" + query, { waitUntil: "load" });
  await page.waitForSelector("html[data-ready]");
  await page.evaluate(() => document.fonts.ready);
  return page;
}

if (only !== "states") {
  for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
    const page = await open(theme, width);
    await page.screenshot({ path: path.join(OUT, `${theme}-${width}.png`), fullPage: true });
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const slice = width < 600 ? 1300 : 1000;
    for (let y = 0, n = 1; y < total; y += slice, n++) {
      await page.screenshot({ path: path.join(OUT, "parts", `${theme}-${width}-${String(n).padStart(2, "0")}.png`), clip: { x: 0, y, width, height: Math.min(slice, total - y) } });
    }
    console.log(`${theme}-${width}.png  (${total}px tall)`);
    await page.close();
  }
  for (const theme of ["light", "dark"]) {
    const page = await open(theme, 320);
    await page.screenshot({ path: path.join(OUT, `${theme}-320-top.png`), clip: { x: 0, y: 0, width: 320, height: 1500 } });
    await page.close();
    const p404 = await browser.newPage();
    await p404.setViewport({ width: 390, height: 760, deviceScaleFactor: 2 });
    await p404.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await p404.goto(server.url + "/nowhere/at-all", { waitUntil: "load" });
    await p404.evaluate(() => document.fonts.ready);
    await p404.screenshot({ path: path.join(OUT, `${theme}-404.png`) });
    await p404.close();
  }
}

if (only !== "pages") {
  const shot = async (page, sel, name) => { const h = await page.$(sel); await h.evaluate(e => e.scrollIntoView({ block: "start" })); await new Promise(r => setTimeout(r, 150)); await h.screenshot({ path: path.join(OUT, "states", name + ".png") }); };
  for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
    const tag = `${theme}-${width}`;
    // daily: a typed answer, a multiple-choice puzzle, a debate
    let page = await open(theme, width);
    await page.type("#daily-input", "long"); await page.keyboard.press("Enter"); await new Promise(r => setTimeout(r, 200));
    await shot(page, "#today", `${tag}-daily-miss`);
    await page.evaluate(() => { document.querySelector("#daily-input").value = ""; }); await page.type("#daily-input", "short"); await page.keyboard.press("Enter");
    await page.waitForSelector("#daily[data-state=done]");
    await page.click("#yesterday summary");
    await shot(page, "#today", `${tag}-daily-solved`);
    await page.close();
    page = await open(theme, width, 900, "?date=2026-10-13"); await shot(page, "#today", `${tag}-daily-choice`); await page.close();
    page = await open(theme, width, 900, "?date=2026-10-27");
    await page.click("#daily .opt:nth-child(2) input"); await page.click("#daily-form button[type=submit]"); await page.waitForSelector("#daily[data-state=done]");
    await shot(page, "#today", `${tag}-daily-debate`); await page.close();

    // games: each one mid-play and at its result
    page = await open(theme, width);
    const go = id => page.evaluate(id => { document.querySelector(`#tab-${id}`).click(); document.querySelector(`#panel-${id} [data-go]`).click(); }, id);
    const done = id => page.waitForSelector(`#panel-${id} .game-body[data-state=done]`, { timeout: 60000 });
    await shot(page, "#play", `${tag}-game-stop-idle`);
    await go("stop"); await new Promise(r => setTimeout(r, 1300)); await shot(page, "#panel-stop", `${tag}-game-stop-running`);
    await page.keyboard.press("Enter"); await done("stop"); await shot(page, "#panel-stop", `${tag}-game-stop-done`);
    await page.evaluate(() => document.querySelector("#tab-stroop").click()); await shot(page, "#panel-stroop", `${tag}-game-stroop-idle`);
    await go("stroop"); await shot(page, "#panel-stroop", `${tag}-game-stroop-running`);
    for (let i = 0; i < 12; i++) await page.keyboard.press("2"); await done("stroop"); await shot(page, "#panel-stroop", `${tag}-game-stroop-done`);
    await go("memory"); await new Promise(r => setTimeout(r, 400)); await shot(page, "#panel-memory", `${tag}-game-memory-study`);
    await page.waitForSelector("#panel-memory .opt-btn:not([hidden])", { timeout: 15000 }); await shot(page, "#panel-memory", `${tag}-game-memory-ask`);
    for (let i = 0; i < 40; i++) { if (await page.$("#panel-memory .game-body[data-state=done]")) break; await page.keyboard.press("1"); const nb = await page.$("#panel-memory [data-go]:not([hidden])"); if (nb && await nb.evaluate(e => e.offsetParent !== null)) break; await new Promise(r => setTimeout(r, 100)); }
    await shot(page, "#panel-memory", `${tag}-game-memory-after`);
    await go("odd"); await shot(page, "#panel-odd", `${tag}-game-odd-running`);
    for (let r = 0; r < 8; r++) await page.evaluate(() => { const cells = [...document.querySelectorAll("#odd-grid .odd-cell")]; const count = {}; cells.forEach(c => { count[c.textContent] = (count[c.textContent] || 0) + 1; }); cells.find(c => count[c.textContent] === 1).click(); });
    await done("odd"); await shot(page, "#panel-odd", `${tag}-game-odd-done`);
    await page.evaluate(() => document.querySelector("#tab-centre").click()); await shot(page, "#panel-centre", `${tag}-game-centre-idle`);
    await go("centre"); await shot(page, "#panel-centre", `${tag}-game-centre-aim`);
    await page.keyboard.press("Enter"); await shot(page, "#panel-centre", `${tag}-game-centre-shown`);
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Enter"); await new Promise(r => setTimeout(r, 60)); await page.focus("#centre-range"); await page.keyboard.press("Enter"); }
    await page.keyboard.press("Enter"); await done("centre"); await shot(page, "#panel-centre", `${tag}-game-centre-done`);
    // wall with answers open
    await page.evaluate(() => { document.querySelectorAll("#wall-list .wall-card button").forEach((b, i) => { if (i < 7) b.click(); }); });
    await shot(page, "#wall", `${tag}-wall-open`);
    await page.close();
  }
}

await browser.close();
await server.close();
console.log("screens/ written");
