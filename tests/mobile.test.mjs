// Phone layout: the section links sit in a bar at the bottom of the screen, nothing hides behind it,
// keyboard hints are not shown on touch screens, and a game can be played with taps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { startServer, CHROME } from "../tools/static-server.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, browser, page;
before(async () => {
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
});
after(async () => { await browser?.close(); await server?.close(); });

for (const width of [320, 390]) test(`phone ${width}px: bottom bar, clear footer, touch play`, async () => {
  await page.setViewport({ width, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(server.url, { waitUntil: "networkidle0" });
  const bar = await page.evaluate(() => { const n = document.querySelector(".nav"), r = n.getBoundingClientRect(); return { pos: getComputedStyle(n).position, bottom: Math.round(r.bottom), h: innerHeight, links: [...n.querySelectorAll("a")].map(a => { const b = a.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), a.scrollWidth <= a.clientWidth + 1]; }), keys: getComputedStyle(document.querySelector(".keys")).display, overflow: document.documentElement.scrollWidth > innerWidth }; });
  assert.equal(bar.pos, "fixed"); assert.equal(bar.bottom, bar.h, "the bar sits on the bottom edge");
  assert.ok(bar.links.length === 4 && bar.links.every(([w, h, fits]) => w >= 44 && h >= 44 && fits), `four thumb-sized links whose labels fit: ${JSON.stringify(bar.links)}`);
  assert.equal(bar.keys, "none", "keyboard hints are hidden on a touch screen"); assert.equal(bar.overflow, false);
  // tapping a link jumps to its section and marks it
  await page.tap('.nav a[href="#play"]'); await sleep(250);
  assert.equal(await page.evaluate(() => document.querySelector('.nav a[aria-current="true"]')?.getAttribute("href")), "#play");
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector("#play").getBoundingClientRect().top) < 40), "the section is at the top of the screen");
  // a game by touch: start and stop the clock
  const btn = await page.evaluateHandle(() => [...document.querySelectorAll("#play button")].find(b => /Start the clock/.test(b.textContent)));
  await btn.asElement().tap(); await sleep(1300);
  const stop = await page.evaluateHandle(() => [...document.querySelectorAll("#play button")].find(b => /^Stop!/.test(b.textContent.trim())));
  const where = await page.evaluate(b => { const r = b.getBoundingClientRect(), nav = document.querySelector(".nav").getBoundingClientRect(), clock = document.querySelector("#play .stage").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), navTop: Math.round(nav.top), clockTop: Math.round(clock.top) }; }, stop);
  assert.ok(where.bottom <= where.navTop && where.clockTop >= 0, `the clock and the Stop button are both on screen above the bar: ${JSON.stringify(where)}`);
  await stop.asElement().tap(); await sleep(700);
  assert.match(await page.evaluate(() => document.querySelector("#play").innerText), /Play again/i);
  // the very end of the page is not hidden behind the bar
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await sleep(150);
  const end = await page.evaluate(() => { const last = [...document.querySelectorAll("footer *")].filter(e => e.offsetParent && !e.children.length).at(-1).getBoundingClientRect(); return { lastBottom: last.bottom, navTop: document.querySelector(".nav").getBoundingClientRect().top }; });
  assert.ok(end.lastBottom <= end.navTop, "the last line of the footer is above the bar");
});

test("wide screens keep the links in the header", async () => {
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(server.url, { waitUntil: "networkidle0" });
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector(".nav")).position), "fixed");
});
