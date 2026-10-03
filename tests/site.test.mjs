// End-to-end checks, run in headless Chrome against a throwaway local server on a random port.
//   npm test          (needs Google Chrome; set CHROME_PATH if it lives somewhere unusual)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { startServer, ROOT, CHROME } from "../tools/static-server.mjs";

const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const POOL = JSON.parse(/<script type="application\/json" id="puzzle-pool">([\s\S]*?)<\/script>/.exec(HTML)[1]);
const EPOCH = Date.UTC(2026, 9, 1) / 864e5;
const expectedIndex = iso => { const [y, m, d] = iso.split("-").map(Number); const n = Date.UTC(y, m - 1, d) / 864e5 - EPOCH; return ((n % POOL.length) + POOL.length) % POOL.length; };
const dateForIndex = i => new Date((EPOCH + i) * 864e5).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = Object.fromEntries(["facebook", "instagram", "url"].map(k => [k, new RegExp(`\\n\\s*${k}: "([^"]*)"`).exec(HTML)[1]]));   // the config as shipped
const ALT_HOST = "headscratch.example";              // mapped to 127.0.0.1 below: a host that is NOT a local development host

let server, browser;
const everyRequest = [];          // every URL any page asked for, checked at the very end
const contexts = [];

before(async () => {
  server = await startServer();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required", `--host-resolver-rules=MAP ${ALT_HOST} 127.0.0.1`] });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/** Opens the site in a clean browser context and records anything that goes wrong on the page. */
async function open({ query = "", pathName = "/", width = 1280, height = 900, theme = "light", motion = "no-preference", prepare, init, expect404 = false, origin = server.url } = {}) {
  const context = await browser.createBrowserContext();
  contexts.push(context);
  await context.overridePermissions(server.url, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const page = await context.newPage();
  const problems = [];
  page.on("console", m => { if (m.type() === "error" && !(expect404 && /404/.test(m.text()))) problems.push("console: " + m.text()); });
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("requestfailed", r => problems.push("requestfailed: " + r.url()));
  page.on("request", r => everyRequest.push(r.url()));
  page.on("response", r => { if (r.status() >= 400 && !expect404) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: motion }]);
  if (init) await page.evaluateOnNewDocument(init);
  if (prepare) await prepare(page);
  await page.goto(origin + pathName + query, { waitUntil: "load" });
  if (pathName === "/") await page.waitForSelector("html[data-ready]");
  await page.evaluate(() => document.fonts.ready);
  return { page, context, problems, done: async () => { assert.deepEqual(problems, [], "the page reported problems"); await context.close(); } };
}
const press = async (page, key, times = 1) => { for (let i = 0; i < times; i++) await page.keyboard.press(key); };
const text = (page, sel) => page.$eval(sel, e => e.textContent.trim());
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem("hss:v1") || "{}"));
const pickGame = async (page, id) => {             // keyboard only: focus the tab strip, then arrow to the game
  const order = ["stop", "stroop", "memory", "odd", "centre"];
  await page.focus('#tabs [role="tab"][tabindex="0"]');
  const at = order.indexOf(await page.$eval('#tabs [aria-selected="true"]', e => e.dataset.game));
  await press(page, "ArrowRight", (order.indexOf(id) - at + order.length) % order.length);
  assert.equal(await page.$eval(`#tab-${id}`, e => e.getAttribute("aria-selected")), "true");
  assert.equal(await page.$eval(`#panel-${id}`, e => e.hidden), false);
  await page.focus(`#panel-${id} [data-go]`);
};
const gameDone = (page, id) => page.waitForSelector(`#panel-${id} .game-body[data-state="done"]`, { timeout: 60000 });

/* ------------------------------------------------------------------ loading */

test("page loads with no console errors, no failed requests and the right head tags", async () => {
  const { page, done } = await open();
  await sleep(400);
  assert.match(await page.title(), /Head Scratch Society/);
  const meta = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("meta[name],meta[property]")].map(m => [m.getAttribute("name") || m.getAttribute("property"), m.content])));
  assert.ok(meta.description.length > 50 && meta.description.length < 170, "meta description of a sensible length");
  for (const k of ["og:title", "og:description", "og:image", "og:type", "og:site_name", "og:image:alt", "twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta[k], `missing ${k}`);
  assert.equal(meta["twitter:card"], "summary_large_image");
  const png = fs.readFileSync(path.join(ROOT, meta["og:image"].replace(SITE.url, "")));
  assert.equal(meta["og:image"], SITE.url + "assets/og.png"); assert.equal(meta["twitter:image"], SITE.url + "assets/og.png");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], "Open Graph image is 1200x630");
  const icons = await page.evaluate(async () => Promise.all([...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].map(async l => [l.getAttribute("href"), (await fetch(l.href)).status])));
  assert.ok(icons.length >= 2); for (const [href, status] of icons) assert.equal(status, 200, href);
  const shape = await page.evaluate(() => ({
    lang: document.documentElement.lang, h1: document.querySelectorAll("h1").length,
    h2: [...document.querySelectorAll("h2")].map(h => h.textContent.trim()),
    landmarks: ["header", "nav", "main", "footer"].map(t => document.querySelectorAll(t).length),
    skips: [...document.querySelectorAll("h1,h2,h3,h4")].map(h => +h.tagName[1]),
    fonts: [document.fonts.check('900 20px "Fraunces"'), document.fonts.check('500 20px "Bricolage Grotesque"')],
    preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map(l => l.getAttribute("href")),
    relative: [...document.querySelectorAll("[src],link[href]:not([rel=canonical])")].map(n => n.getAttribute("src") || n.getAttribute("href")).filter(u => /^(\/|https?:)/.test(u)),
    h1Text: document.querySelector("h1").textContent.replace(/\s+/g, " ").trim()
  }));
  assert.equal(shape.lang, "en");
  assert.equal(shape.h1, 1); assert.equal(shape.h1Text, "Head Scratch Society");
  assert.deepEqual(shape.h2.slice(0, 4), ["Today's scratcher", "Play", "The wall", "House rules"]);
  assert.deepEqual(shape.landmarks, [1, 1, 1, 1]);
  shape.skips.reduce((prev, lv) => { assert.ok(lv <= prev + 1, "heading levels never skip a level"); return lv; }, 0);
  assert.deepEqual(shape.fonts, [true, true], "both brand fonts loaded");
  assert.equal(shape.preloads.length, 2, "both fonts are preloaded");
  assert.deepEqual(shape.relative, [], "asset URLs are relative, so the site works from a sub-path");
  assert.match(HTML, /font-display:swap/);
  await done();
});

test("fonts arriving late barely move the layout (cumulative layout shift under 0.05)", async () => {
  const { page, done } = await open({
    prepare: async page => {
      await page.setRequestInterception(true);
      page.on("request", async r => { if (r.url().endsWith(".woff2")) await sleep(700); r.continue(); });
    },
    init: () => { window.__cls = 0; new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); }
  });
  await sleep(600);
  const cls = await page.evaluate(() => window.__cls);
  console.log(`    layout shift with fonts delayed 0.7 s: ${cls.toFixed(4)}`);
  assert.ok(cls < 0.05, `cumulative layout shift was ${cls.toFixed(4)}`);
  await done();
});

/* ------------------------------------------------------------------ daily puzzle */

test("the daily puzzle is deterministic for a date, moves on each day and wraps round the pool", async () => {
  assert.ok(POOL.length >= 30, "at least 30 puzzles");
  const idFor = async (iso, tz) => {
    const { page, done } = await open({ query: `?date=${iso}`, prepare: tz ? p => p.emulateTimezone(tz) : undefined });
    const ids = await page.evaluate(() => [document.querySelector("#daily").dataset.puzzleId, document.querySelector("#yesterday").dataset.puzzleId, document.querySelector("#daily .num").textContent]);
    await done(); return ids;
  };
  const a = await idFor("2026-10-05"), b = await idFor("2026-10-05");
  assert.deepEqual(a, b, "same date, same puzzle");
  assert.equal(a[0], POOL[expectedIndex("2026-10-05")].id); assert.equal(a[0], POOL[4].id); assert.equal(a[2], "No. 05");
  assert.equal(a[1], POOL[3].id, "yesterday's answer belongs to the day before");
  const next = await idFor("2026-10-06");
  assert.equal(next[0], POOL[5].id); assert.equal(next[1], a[0], "today becomes yesterday");
  assert.equal((await idFor("2026-10-01"))[0], POOL[0].id, "puzzle No. 01 runs on launch day");
  assert.equal((await idFor("2026-09-30"))[0], POOL.at(-1).id, "dates before launch wrap backwards");
  const wrapped = new Date(Date.UTC(2026, 9, 5 + POOL.length)).toISOString().slice(0, 10);
  assert.equal((await idFor(wrapped))[0], a[0], "the pool repeats after its full length");
  assert.equal((await idFor("2026-10-05", "Pacific/Kiritimati"))[0], a[0]);
  assert.equal((await idFor("2026-10-05", "Pacific/Pago_Pago"))[0], a[0]);
});

test("the ?date= test hook is ignored on a host that is not a local development host", async () => {
  const { page, done } = await open({ origin: `http://${ALT_HOST}:${new URL(server.url).port}`, query: "?date=2031-03-09" });
  const now = new Date(), local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.equal(await page.evaluate(() => location.hostname), ALT_HOST);
  assert.equal(await page.$eval("#daily", e => e.dataset.date), local, "the real date wins");
  assert.equal(await page.$eval("#daily", e => e.dataset.puzzleId), POOL[expectedIndex(local)].id);
  await done();
});

test("without the test hook, the puzzle follows the visitor's own calendar date", async () => {
  for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {      // a full day apart
    const { page, done } = await open({ prepare: p => p.emulateTimezone(tz) });
    const got = await page.$eval("#daily", e => [e.dataset.puzzleId, e.dataset.date]);
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    assert.equal(got[1], local, `${tz}: uses the local date`);
    assert.equal(got[0], POOL[expectedIndex(local)].id);
    await done();
  }
});

test("daily, typed answer by keyboard: a miss, then solved, with streak and reload persistence", async () => {
  const seed = () => { if (!localStorage.getItem("hss:v1")) localStorage.setItem("hss:v1", JSON.stringify({ daily: { "2026-10-03": { id: "gaps-double", r: "solved", tries: 1 }, "2026-10-04": { id: "snail", r: "peeked", tries: 0 }, "2026-10-01": { id: "sticker", r: "solved", tries: 1 } }, best: {}, sound: false })); };
  const { page, done } = await open({ query: "?date=2026-10-05", init: seed });
  assert.equal(await page.$eval("#streak", e => e.dataset.streak), "2", "two days in a row before today (the gap on the 2nd breaks it)");
  assert.equal(await page.$eval('#wall-list [data-id="shorter"] a', e => e.getAttribute("href")), "#today", "today's puzzle is locked on the wall until played");
  await page.focus("#daily-input");
  await press(page, "Enter");
  await page.waitForFunction(() => /guess first/i.test(document.querySelector("#daily-feedback").textContent));   // an empty guess is not counted
  await page.evaluate(() => { document.querySelector("#daily-feedback").textContent = ""; });
  await page.keyboard.type("long"); await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#daily-feedback").textContent.length > 0);
  assert.equal(await page.$eval("#daily", e => e.dataset.state), "open");
  assert.equal(await page.$eval("#daily-feedback", e => e.getAttribute("aria-live")), "polite");
  assert.equal(await page.$("#daily .answer"), null, "no answer shown after a miss");
  await page.keyboard.type("  The SHORT. "); await press(page, "Enter");            // input was selected, so this replaces it
  await page.waitForSelector('#daily[data-state="done"]');
  assert.equal(await text(page, "#daily-verdict"), "Cracked it in 2 tries.");
  assert.equal(await page.evaluate(() => document.activeElement.id), "daily-verdict", "focus moves to the result");
  assert.equal(await text(page, "#daily .answer-a"), "Short.");
  assert.match(await text(page, "#daily .answer"), /The trap/);
  assert.equal(await page.$eval("#streak", e => e.dataset.streak), "3");
  assert.ok(await page.$('#wall-list [data-id="shorter"] button[aria-expanded]'), "the wall card unlocks once today's puzzle is played");
  const share = await page.$eval("#daily [data-share]", e => e.dataset.share);
  assert.equal(share, "I cracked scratcher No. 05 in 2 tries. Head Scratch Society");
  assert.ok(!/short/i.test(share), "shared text carries no spoiler");
  await page.reload({ waitUntil: "load" }); await page.waitForSelector("html[data-ready]");
  assert.equal(await page.$eval("#daily", e => e.dataset.state), "done", "result survives a reload");
  assert.equal(await text(page, "#daily-verdict"), "Cracked it in 2 tries.");
  assert.deepEqual((await stored(page)).daily["2026-10-05"], { id: "shorter", r: "solved", tries: 2 });
  await done();
});

test("daily: multiple choice, think-then-reveal, debate and peeking all reach a result by keyboard", async () => {
  // multiple choice (No. 13, the boxes)
  let s = await open({ query: `?date=${dateForIndex(POOL.findIndex(p => p.id === "boxes"))}` });
  await s.page.focus("#daily-form .opt input"); await press(s.page, "Space"); await press(s.page, "Enter");
  await s.page.waitForFunction(() => document.querySelector("#daily-feedback").textContent.length > 0);
  assert.equal(await s.page.$eval("#daily-form .opt input", e => e.disabled), true, "a wrong option is struck out");
  await press(s.page, "ArrowRight");                                    // first remaining option is focused; move to MIXED
  assert.equal(await s.page.evaluate(() => document.activeElement.value), "2");
  await press(s.page, "Enter");
  await s.page.waitForSelector('#daily[data-state="done"]');
  assert.equal(await text(s.page, "#daily-verdict"), "Cracked it in 2 tries.");
  await s.done();

  // think, reveal, own up (No. 09, the forest)
  s = await open({ query: `?date=${dateForIndex(POOL.findIndex(p => p.id === "forest"))}` });
  assert.equal(await s.page.$("#daily .answer"), null);
  await s.page.focus("#daily-show"); await press(s.page, "Enter");
  assert.equal(await text(s.page, "#daily .answer-a"), "Halfway.");
  assert.equal(await s.page.evaluate(() => document.activeElement.id), "daily-got");
  await press(s.page, "Tab"); await press(s.page, "Enter");                // "It got me"
  await s.page.waitForSelector('#daily[data-state="done"]');
  assert.match(await text(s.page, "#daily-verdict"), /got you/);
  assert.equal(await s.page.$eval("#daily [data-share]", e => e.dataset.share), "Scratcher No. 09 got me. Head Scratch Society");
  await s.done();

  // debate (No. 07): both sides shown, no single answer declared
  s = await open({ query: `?date=${dateForIndex(POOL.findIndex(p => p.id === "months"))}` });
  assert.equal(await s.page.$("#daily-peek"), null, "a debate has no answer to peek at");
  await s.page.focus("#daily-form .opt input"); await press(s.page, "Space"); await press(s.page, "ArrowDown"); await press(s.page, "Enter");
  await s.page.waitForSelector('#daily[data-state="done"]');
  assert.equal(await s.page.$$eval("#daily .side", e => e.length), 2);
  assert.equal(await s.page.$$eval("#daily .side--mine", e => e.length), 1);
  assert.match(await text(s.page, "#daily-verdict"), /team “Twelve”/);
  assert.equal(await s.page.$("#daily .answer"), null, "no verdict from the house");
  assert.match(await text(s.page, "#daily .ask"), /\?$/);
  await s.done();

  // numbers typed the way people type them
  for (const [id, typed, ok] of [["look-say", "312,211", true], ["look-say", "312 211", true], ["sticker", "Ten cents", true], ["sticker", "10.0", true], ["sticker", "20", false], ["snail", "day 10", true], ["snail", "ten", true], ["snail", "", false], ["snail", "about a week", false]]) {
    s = await open({ query: `?date=${dateForIndex(POOL.findIndex(p => p.id === id))}` });
    await s.page.focus("#daily-input"); if (typed) await s.page.keyboard.type(typed); await press(s.page, "Enter");
    await s.page.waitForFunction(() => document.querySelector("#daily").dataset.state === "done" || document.querySelector("#daily-feedback").textContent.length > 0);
    assert.equal(await s.page.$eval("#daily", e => e.dataset.state), ok ? "done" : "open", `${id}: “${typed}”`);
    await s.done();
  }

  // bad saved data is ignored instead of breaking the page
  s = await open({ init: () => localStorage.setItem("hss:v1", '{"daily":"nope","best":{"stop":7,"odd":"fast","stroop":9.5},"sound":"yes"}') });
  assert.equal(await text(s.page, "#tab-stop .tab-best"), "No score yet"); assert.equal(await text(s.page, "#tab-stroop .tab-best"), "Best 9.50 s");
  assert.equal(await s.page.$eval("#sound-toggle", e => e.getAttribute("aria-pressed")), "false");
  await s.done();
  s = await open({ init: () => localStorage.setItem("hss:v1", "{not json") });
  assert.equal(await s.page.$eval("#daily", e => e.dataset.state), "open");
  await s.done();

  // peeking
  s = await open({ query: "?date=2026-10-02" });
  await s.page.focus("#daily-peek"); await press(s.page, "Enter");
  await s.page.waitForSelector('#daily[data-state="done"]');
  assert.equal(await text(s.page, "#daily .answer-a"), "Biscuit.");
  assert.equal((await stored(s.page)).daily["2026-10-02"].r, "peeked");
  assert.equal(await s.page.$eval("#streak", e => e.dataset.streak), "1", "a peek still counts as a day played");
  await s.done();
});

test("every typed puzzle in the pool accepts its own answer, and every choice puzzle its own option", async () => {
  const { page, done } = await open({ query: "?date=2026-10-01" });
  let n = 0;
  for (const [i, p] of POOL.entries()) {
    if (!["num", "text", "choice"].includes(p.kind)) continue;
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${server.url}/?date=${dateForIndex(i)}`, { waitUntil: "load" }); await page.waitForSelector("html[data-ready]");
    assert.equal(await page.$eval("#daily", e => e.dataset.puzzleId), p.id);
    if (p.kind === "choice") { await page.click(`#daily-form .opt:nth-child(${p.ans + 1}) input`); await page.focus("#daily-form button[type=submit]"); }
    else { await page.focus("#daily-input"); await page.keyboard.type(p.kind === "num" ? String(p.ans) : p.a.replace(/\.$/, "")); }
    await press(page, "Enter");
    await page.waitForSelector('#daily[data-state="done"]', { timeout: 3000 }).catch(() => assert.fail(`${p.id}: the shown answer was not accepted`));
    assert.equal(await text(page, "#daily-verdict"), "Cracked it first go.", p.id);
    n++;
  }
  assert.ok(n >= 30);
  await done();
});

/* ------------------------------------------------------------------ the games, keyboard only */

test("Stop at 10.00: plays to a result by keyboard, digits fade, best is kept", async () => {
  const { page, done } = await open();
  await pickGame(page, "stop");
  await press(page, "Enter");
  assert.equal(await page.$eval("#panel-stop .game-body", e => e.dataset.state), "running");
  await sleep(1000);
  assert.equal(await page.$eval("#panel-stop .clock", e => e.classList.contains("is-hidden")), false, "digits still showing at 1 second");
  await sleep(2300);
  assert.equal(await page.$eval("#panel-stop .clock", e => e.classList.contains("is-hidden")), true, "digits hidden after 3 seconds");
  await press(page, "Space");
  await gameDone(page, "stop");
  const big = await text(page, "#panel-stop .result-big");
  assert.match(big, /^\d\.\d\d$/); assert.ok(+big > 3.2 && +big < 6, `stopped at ${big}`);
  assert.equal(await page.$eval("#panel-stop .result-text", e => e.getAttribute("aria-live")), "polite");
  assert.match(await text(page, "#panel-stop .result-kicker"), /New personal best/);
  assert.match(await text(page, "#panel-stop .result-detail"), /seconds early\.$/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Play again");
  const best = (await stored(page)).best.stop;
  assert.equal(best.t.toFixed(2), big); assert.equal(best.d, Math.round((10 - best.t) * 100) / 100);
  assert.equal(await text(page, "#tab-stop .tab-best"), `Best ${big} s`);
  assert.equal(await page.$eval("#panel-stop [data-share]", e => e.dataset.share), `I stopped the clock at ${big}, aiming for 10.00. Head Scratch Society`);
  // replay: a worse score does not replace the best
  await sleep(500); await press(page, "Enter");
  assert.equal(await page.$eval("#panel-stop .game-body", e => e.dataset.state), "running");
  await sleep(400); await press(page, "Enter"); await gameDone(page, "stop");
  assert.match(await text(page, "#panel-stop .result-kicker"), /Your result/);
  assert.equal((await stored(page)).best.stop.t.toFixed(2), big);
  await page.reload({ waitUntil: "load" }); await page.waitForSelector("html[data-ready]");
  assert.equal(await text(page, "#tab-stop .tab-best"), `Best ${big} s`, "best survives a reload");
  await done();
});

test("Say the colour: plays to a result by keyboard, slips cost two seconds each", async () => {
  const { page, done } = await open();
  await pickGame(page, "stroop");
  assert.match(await text(page, "#panel-stroop .note"), /colour test/, "says plainly that it is a colour test");
  const KEYS = { "rgb(255, 90, 69)": "1", "rgb(255, 197, 49)": "2", "rgb(25, 194, 154)": "3", "rgb(63, 169, 245)": "4" };
  const NAMES = { 1: "Red", 2: "Yellow", 3: "Green", 4: "Blue" };
  const seen = new Set(); let clash = 0;
  await press(page, "Enter");
  for (let i = 0; i < 12; i++) {
    assert.match(await text(page, "#panel-stroop .hud"), new RegExp(`Word ${i + 1} of 12`));
    const { ink, word } = await page.$eval("#stroop-word", e => ({ ink: getComputedStyle(e).color, word: e.textContent }));
    assert.ok(KEYS[ink], `unknown ink ${ink}`); seen.add(ink); if (NAMES[KEYS[ink]] !== word) clash++;
    const key = i === 5 ? String((+KEYS[ink] % 4) + 1) : KEYS[ink];     // one deliberate slip
    await press(page, key);
  }
  await gameDone(page, "stroop");
  assert.ok(clash >= 4, "most words clash with their ink");
  assert.match(await text(page, "#panel-stroop .result-big"), /^\d+\.\d\d s$/);
  assert.equal(await text(page, "#panel-stroop .result-detail"), "1 slip added 2 seconds.");
  const best = (await stored(page)).best.stroop;
  assert.ok(best >= 2 && best < 9, `time ${best} includes the 2 second penalty`);
  await sleep(500); await press(page, "Enter");                        // play again, clean this time, using the buttons
  for (let i = 0; i < 12; i++) {
    const ink = await page.$eval("#stroop-word", e => getComputedStyle(e).color);
    await page.focus(`#panel-stroop .opt-btn:nth-child(${KEYS[ink]})`); await press(page, "Enter");
  }
  await gameDone(page, "stroop");
  assert.equal(await text(page, "#panel-stroop .result-detail"), "No slips. A clean run.");
  // hammering one key must cost more than it saves: 12 words, at least 6 slips, at least 12 seconds
  await sleep(500); await press(page, "Enter"); await press(page, "1", 12); await gameDone(page, "stroop");
  const mashed = parseFloat(await text(page, "#panel-stroop .result-big"));
  assert.ok(mashed >= 12, `mashing scored ${mashed} s`);
  assert.match(await text(page, "#panel-stroop .result-line"), /The words won this round/);
  await done();
});

test("Gone in five: questions are answerable from the board, a run ends on a miss", async () => {
  const { page, done } = await open();
  await pickGame(page, "memory");
  await press(page, "Enter");
  const SPOTS = ["top left", "top middle", "top right", "middle left", "centre", "middle right", "bottom left", "bottom middle", "bottom right"];
  const solve = (q, scene, labels) => {
    let m, want;
    if ((m = /^How many (\w+) were on the board\?$/.exec(q))) { const k = m[1] === "crosses" ? "cross" : m[1].replace(/s$/, ""); want = String(scene.filter(c => c === k).length); }
    else if ((m = /^What was in the (.+) tile\?$/.exec(q))) { const v = scene[SPOTS.indexOf(m[1])]; want = v === "empty" ? "Nothing" : v[0].toUpperCase() + v.slice(1); }
    else if (q === "Which of these was NOT on the board?") { const out = labels.filter(l => !scene.includes(l.toLowerCase())); assert.equal(out.length, 1, "exactly one option was not on the board"); want = out[0]; }
    else if (q === "How many tiles were empty?") want = String(scene.filter(c => c === "empty").length);
    else if ((m = /^Where was the (\w+)\?$/.exec(q))) { assert.equal(scene.filter(c => c === m[1]).length, 1); const s = SPOTS[scene.indexOf(m[1])]; want = s[0].toUpperCase() + s.slice(1); }
    else assert.fail("unknown question: " + q);
    const hits = labels.map((l, i) => l === want ? i : -1).filter(i => i >= 0);
    assert.equal(hits.length, 1, `"${q}" should have exactly one right option (${want}) among ${labels}`);
    return hits[0];
  };
  const kinds = new Set();
  for (let level = 1; level <= 4; level++) {
    await page.waitForFunction(() => document.querySelector("#mem-grid").getAttribute("aria-label").startsWith("The board, row by row"));
    const label = await page.$eval("#mem-grid", e => e.getAttribute("aria-label"));
    const scene = label.replace(/^[^:]+: /, "").replace(/\.$/, "").split("; ").map(s => s.split(", ")[1]);
    assert.equal(scene.length, 9); assert.equal(scene.filter(c => c !== "empty").length, Math.min(3 + level, 9), `board ${level} has ${3 + level} shapes`);
    assert.equal(await page.$$eval("#mem-grid .mem-tile svg", e => e.length), 3 + level, "shapes are drawn while studying");
    for (let qn = 0; qn < 2; qn++) {
      await page.waitForFunction(n => { const q = document.querySelector("#mem-q").textContent; return q.endsWith("?") && document.querySelectorAll("#panel-memory .optbar .opt-btn:not([hidden])").length === 4 && q !== window.__lastQ; }, { timeout: 9000 }, qn);
      const { q, labels, covered } = await page.evaluate(() => { const q = document.querySelector("#mem-q").textContent; window.__lastQ = q; return { q, covered: document.querySelectorAll("#mem-grid .mem-tile.is-covered").length, labels: [...document.querySelectorAll("#panel-memory .optbar .opt-btn")].map(b => [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("")) }; });
      assert.equal(covered, 9, "the board is covered while questions are asked");
      kinds.add(q.replace(/the \w+( \w+)? tile|many \w+ were on|the \w+\?/, "_"));
      const right = solve(q, scene, labels);
      if (level === 4 && qn === 1) { await press(page, String(((right + 1) % 4) + 1)); break; }       // deliberate miss
      await press(page, String(right + 1));
    }
    if (level < 4) {
      await page.waitForFunction(() => /cleared/.test(document.querySelector("#mem-q").textContent));
      assert.equal(await page.evaluate(() => document.activeElement.textContent), "Next board");
      await page.evaluate(() => { window.__lastQ = ""; });
      await press(page, "Enter");
    }
  }
  await gameDone(page, "memory");
  assert.equal(await text(page, "#panel-memory .result-big"), "3 boards");
  assert.match(await text(page, "#mem-q"), /^Not that\. It was: /);
  assert.equal(await page.$$eval("#mem-grid .mem-tile.is-covered", e => e.length), 0, "the board is shown again at the end");
  assert.equal((await stored(page)).best.memory, 3);
  assert.equal(await page.$eval("#panel-memory [data-share]", e => e.dataset.share), "I cleared 3 boards from memory. Head Scratch Society");
  await done();
});

test("Odd one out: plays to a result by keyboard, a wrong pick costs 2 seconds", async () => {
  const { page, done } = await open({ width: 320, height: 700 });       // the smallest phone we support: the 5x5 grid must still fit
  await pickGame(page, "odd");
  await press(page, "Enter");
  const sizes = [];
  for (let round = 0; round < 8; round++) {
    await page.waitForFunction(r => document.querySelector("#panel-odd .hud").textContent.includes(`Grid ${r + 1} of 8`), {}, round);
    const { n, odd, focused } = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("#odd-grid .odd-cell")], count = {};
      cells.forEach(c => { count[c.textContent] = (count[c.textContent] || 0) + 1; });
      return { n: Math.sqrt(cells.length), odd: cells.findIndex(c => count[c.textContent] === 1), focused: cells.indexOf(document.activeElement), kinds: Object.keys(count).length };
    });
    sizes.push(n); assert.equal(focused, 0, "focus starts on the first cell");
    const fit = await page.evaluate(() => { const g = document.querySelector("#odd-grid").parentElement.getBoundingClientRect(); return [...document.querySelectorAll("#odd-grid .odd-cell")].map(c => c.getBoundingClientRect()).every(r => r.width >= 44 && r.height >= 44 && r.left >= g.left && r.right <= g.right); });
    assert.equal(fit, true, `every cell of the ${n}x${n} grid is at least 44px and inside the stage`);
    if (round === 0) {                                                  // one wrong pick first
      const wrong = odd === 0 ? 1 : 0;
      await press(page, "ArrowRight", wrong); await press(page, "Enter");
      assert.equal(await page.$eval(`#odd-grid .odd-cell:nth-child(${wrong + 1})`, e => e.classList.contains("is-wrong")), true);
      await press(page, "Home");
    }
    await press(page, "ArrowDown", Math.floor(odd / n)); await press(page, "ArrowRight", odd % n);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#odd-grid .odd-cell")].indexOf(document.activeElement)), odd, "arrow keys reach the odd cell");
    await press(page, round % 2 ? "Enter" : "Space");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no sideways scroll on a ${n}x${n} grid`);
  }
  await gameDone(page, "odd");
  assert.deepEqual(sizes, [3, 3, 4, 4, 4, 5, 5, 5]);
  assert.match(await text(page, "#panel-odd .result-big"), /^\d+\.\d s$/);
  assert.equal(await text(page, "#panel-odd .result-detail"), "1 wrong pick added 2 seconds.");
  const best = (await stored(page)).best.odd; assert.ok(best >= 2 && best < 30, `time ${best} includes the penalty`);
  await done();
});

test("Dead centre: plays to a result by keyboard, and the true middle scores 0.0%", async () => {
  const { page, done } = await open();
  await pickGame(page, "centre");
  await press(page, "Enter");
  for (let round = 0; round < 5; round++) {
    assert.equal(await page.evaluate(() => document.activeElement.id), "centre-range", "focus is on the slider");
    const { centre, value } = await page.evaluate(() => { const [, a, b] = /M([\d.]+) [\d.]+H([\d.]+)/.exec(document.querySelector("#panel-centre .ln").getAttribute("d")); return { centre: (+a + +b) / 2, value: +document.querySelector("#centre-range").value }; });
    assert.ok(Number.isInteger(centre), "the middle sits on a whole slider step");
    assert.ok(Math.abs(value - centre) >= 45, "the marker never starts near the middle");
    const target = round === 4 ? centre + 6 : centre;                   // miss the last one slightly
    await press(page, target > value ? "ArrowRight" : "ArrowLeft", Math.abs(target - value));
    assert.equal(await page.$eval("#centre-range", e => +e.value), target);
    await press(page, "Enter");                                         // lock it in
    assert.match(await text(page, "#centre-say"), round === 4 ? /^\d\.\d% out, to the right\./ : /^Dead centre\./);
    assert.ok(await page.$("#panel-centre .true-dot"), "the true middle is revealed");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), round === 4 ? "See my score" : "Next line");
    await press(page, "Enter");
  }
  await gameDone(page, "centre");
  const big = await text(page, "#panel-centre .result-big");
  assert.match(big, /^\d\.\d%$/); assert.ok(parseFloat(big) > 0 && parseFloat(big) < 1.2, `average miss ${big}`);
  assert.equal((await stored(page)).best.centre, parseFloat(big));
  await done();
});

test("game tabs work with arrow keys, and switching games resets the one you left", async () => {
  const { page, done } = await open();
  await pickGame(page, "stop"); await press(page, "Enter");
  assert.equal(await page.$eval("#panel-stop .game-body", e => e.dataset.state), "running");
  await page.focus("#tab-stop"); await press(page, "ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement.id), "tab-centre", "arrow keys wrap round");
  assert.equal(await page.$eval("#panel-stop .game-body", e => e.dataset.state), "idle");
  assert.equal(await page.$$eval('#panels [role="tabpanel"]:not([hidden])', e => e.length), 1);
  assert.equal(await page.$$eval('#tabs [role="tab"][tabindex="0"]', e => e.length), 1);
  await press(page, "Home"); assert.equal(await page.evaluate(() => document.activeElement.id), "tab-stop");
  await press(page, "End"); assert.equal(await page.evaluate(() => document.activeElement.id), "tab-centre");
  await done();
});

/* ------------------------------------------------------------------ share */

async function finishStop(page) { await pickGame(page, "stop"); await press(page, "Enter"); await sleep(350); await press(page, "Enter"); await gameDone(page, "stop"); return text(page, "#panel-stop .result-big"); }

test("share: without the Web Share API the brag is copied to the clipboard, with a clean URL", async () => {
  const { page, done } = await open({ query: "?date=2026-10-05", init: () => { Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }); } });
  const big = await finishStop(page);
  await press(page, "Tab"); assert.equal(await page.evaluate(() => document.activeElement.textContent), "Share");
  await press(page, "Enter");
  await page.waitForSelector("#toast.is-on");
  assert.match(await text(page, "#toast"), /^Copied\./);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, `I stopped the clock at ${big}, aiming for 10.00. Head Scratch Society ${SITE.url || server.url + "/"}`);
  assert.ok(!/[?#&=]/.test(copied.split(" ").at(-1)), "no query string, no tracking parameters");
  await done();
});

test("share: with no clipboard API either, the old copy command is used", async () => {
  const { page, done } = await open({ init: () => {
    Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, "clipboard", { value: undefined, configurable: true });
    document.execCommand = cmd => { window.__copied = cmd === "copy" ? document.querySelector("body > textarea").value : null; return true; };
  } });
  const big = await finishStop(page);
  await press(page, "Tab"); await press(page, "Enter");
  await page.waitForSelector("#toast.is-on");
  assert.match(await text(page, "#toast"), /^Copied\./);
  assert.equal(await page.evaluate(() => window.__copied), `I stopped the clock at ${big}, aiming for 10.00. Head Scratch Society ${SITE.url || server.url + "/"}`);
  await done();
});

test("share: the Web Share API is used when the browser has it", async () => {
  const { page, done } = await open({ init: () => { window.__shared = []; Object.defineProperty(Navigator.prototype, "share", { value: d => { window.__shared.push(d); return Promise.resolve(); }, configurable: true }); } });
  const big = await finishStop(page);
  await press(page, "Tab"); await press(page, "Enter"); await sleep(100);
  assert.deepEqual(await page.evaluate(() => window.__shared), [{ text: `I stopped the clock at ${big}, aiming for 10.00. Head Scratch Society`, url: SITE.url || `${server.url}/` }]);
  assert.equal(await page.$eval("#toast", e => e.classList.contains("is-on")), false, "no copy toast when the share sheet opened");
  await done();
});

/* ------------------------------------------------------------------ theme, sound, privacy */

test("theme follows the system, the toggle switches it, and the choice is remembered", async () => {
  const bg = page => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  let s = await open({ theme: "light" });
  assert.equal(await bg(s.page), "rgb(255, 247, 232)");
  assert.equal(await s.page.$eval("#theme-toggle", e => e.getAttribute("aria-pressed")), "false");
  await s.page.focus("#theme-toggle"); await press(s.page, "Enter");
  assert.equal(await bg(s.page), "rgb(23, 19, 43)");
  assert.equal(await s.page.$eval("#theme-toggle", e => e.getAttribute("aria-pressed")), "true");
  assert.equal(await s.page.evaluate(() => localStorage.getItem("hss:theme")), "dark");
  await s.page.reload({ waitUntil: "load" }); await s.page.waitForSelector("html[data-ready]");
  assert.equal(await bg(s.page), "rgb(23, 19, 43)", "dark is remembered although the system says light");
  await s.page.focus("#theme-toggle"); await press(s.page, "Space");
  assert.equal(await bg(s.page), "rgb(255, 247, 232)");
  await s.page.reload({ waitUntil: "load" }); await s.page.waitForSelector("html[data-ready]");
  assert.equal(await bg(s.page), "rgb(255, 247, 232)", "light is remembered");
  await s.done();
  s = await open({ theme: "dark" });
  assert.equal(await bg(s.page), "rgb(23, 19, 43)", "follows a dark system setting");
  assert.equal(await s.page.$eval("#theme-toggle", e => e.getAttribute("aria-pressed")), "true");
  await s.page.click("#theme-toggle");
  assert.equal(await bg(s.page), "rgb(255, 247, 232)", "and can be switched to light");
  await s.done();
});

test("sound is off by default and nothing audio starts until it is switched on", async () => {
  const { page, done } = await open({ init: () => { window.__audio = 0; const Real = window.AudioContext; window.AudioContext = class extends Real { constructor(...a) { super(...a); window.__audio++; } }; } });
  assert.equal(await page.$eval("#sound-toggle", e => e.getAttribute("aria-pressed")), "false");
  await finishStop(page);
  assert.equal(await page.evaluate(() => window.__audio), 0, "no audio while sound is off");
  await page.focus("#sound-toggle"); await press(page, "Enter");
  assert.equal(await page.$eval("#sound-toggle", e => e.getAttribute("aria-pressed")), "true");
  assert.equal(await page.evaluate(() => window.__audio), 1);
  assert.equal((await stored(page)).sound, true);
  assert.equal(await page.$$eval("audio,video", e => e.length), 0, "no audio files, synthesised only");
  await done();
});

test("privacy: no cookies, only our own two storage keys, and 'Forget my scores' wipes them", async () => {
  const { page, done } = await open({ query: "?date=2026-10-05" });
  await finishStop(page);
  await page.focus("#daily-peek"); await press(page, "Enter");
  await page.click("#theme-toggle");
  const state = await page.evaluate(() => ({ cookie: document.cookie, local: Object.keys(localStorage).sort(), session: sessionStorage.length }));
  assert.deepEqual(state, { cookie: "", local: ["hss:theme", "hss:v1"], session: 0 });
  assert.match(await text(page, ".privacy"), /No accounts\. No cookies\. No tracking\./);
  await page.focus("#forget"); await press(page, "Enter");
  assert.match(await text(page, "#forget"), /^Sure\?/, "asks before wiping");
  assert.ok((await stored(page)).best.stop, "nothing wiped on the first press");
  await press(page, "Enter");
  assert.equal(await page.evaluate(() => localStorage.getItem("hss:v1")), null);
  assert.equal(await text(page, "#tab-stop .tab-best"), "No score yet");
  assert.equal(await page.$eval("#daily", e => e.dataset.state), "open");
  assert.equal(await page.$eval("#streak", e => e.dataset.streak), "0");
  await done();
});

/* ------------------------------------------------------------------ the wall, follow links, 404 */

test("the wall lists the whole pool, filters by type and reveals answers on demand", async () => {
  const { page, done } = await open({ query: "?date=2026-10-05" });
  assert.equal(await page.$$eval("#wall-list .wall-card", e => e.length), 9);
  assert.equal(await page.$$eval("#wall-list .answer, #wall-list .sides", e => e.length), 0, "no answers in the page until asked for");
  await page.focus("#wall-more"); await press(page, "Enter");
  assert.equal(await page.$$eval("#wall-list .wall-card", e => e.length), POOL.length);
  assert.deepEqual(await page.$$eval("#wall-list .wall-card", e => e.map(c => c.dataset.id)), POOL.map(p => p.id));
  assert.equal(await page.evaluate(() => document.activeElement.closest(".wall-card")?.dataset.id), POOL[9].id, "focus lands on the first newly shown card");
  const filters = await page.$$eval("#filters .filter", e => e.map(b => [b.dataset.filter, b.textContent, b.getAttribute("aria-pressed")]));
  assert.deepEqual(filters.map(f => f[0]), ["all", "number", "story", "sequence", "riddle", "word", "logic", "debate"]);
  for (const [k, label] of filters.slice(1)) assert.ok(label.endsWith(`(${POOL.filter(p => p.type === k).length})`), `${label} shows the real count`);
  await page.focus('#filters [data-filter="riddle"]'); await press(page, "Enter");
  const riddles = POOL.filter(p => p.type === "riddle");
  assert.equal(await page.$eval('#filters [data-filter="riddle"]', e => e.getAttribute("aria-pressed")), "true");
  assert.equal(await page.$eval('#filters [data-filter="all"]', e => e.getAttribute("aria-pressed")), "false");
  assert.deepEqual(await page.$$eval("#wall-list .wall-card", e => e.map(c => c.dataset.type)), riddles.map(() => "riddle"));
  assert.equal(await text(page, "#wall-status"), `Showing ${riddles.length} of ${riddles.length} riddles.`);
  await page.focus('#wall-list [data-id="biscuit"] button'); await press(page, "Enter");
  assert.equal(await page.$eval('#wall-list [data-id="biscuit"] button', e => e.getAttribute("aria-expanded")), "true");
  assert.equal(await text(page, '#wall-list [data-id="biscuit"] .answer-a'), "Biscuit.");
  await press(page, "Enter");
  assert.equal(await page.$eval('#wall-list [data-id="biscuit"] .wall-a', e => e.hidden), true);
  await page.click('#filters [data-filter="debate"]');
  await page.click('#wall-list [data-id="straw"] button');
  assert.equal(await page.$$eval('#wall-list [data-id="straw"] .side', e => e.length), 3);
  assert.equal(await page.$('#wall-list [data-id="straw"] .answer'), null, "debates show sides, not an answer");
  await done();
});

test("follow links stay hidden while the config is empty, and appear when it is filled in", async () => {
  let s = await open();
  const live = ["facebook", "instagram"].filter(k => SITE[k]);
  assert.equal(await s.page.$eval("#follow", e => e.hidden), live.length === 0);
  assert.deepEqual(await s.page.$$eval("a[data-follow]", e => e.map(a => a.dataset.follow)), live);
  assert.equal(await s.page.$$eval('a[href^="http"]', e => e.length), 2 * live.length + (SITE.facebook ? 1 : 0), "no outbound links except the configured ones (follow buttons, footer links, the inline Page link)");
  assert.deepEqual(await s.page.$$eval("#foot-links a", e => e.map(a => a.href)), live.map(k => SITE[k]));
  assert.equal(!!(await s.page.$("#fb-inline a")), !!SITE.facebook);
  await s.done();
  s = await open({ prepare: async page => {
    await page.setRequestInterception(true);
    page.on("request", r => {
      if (r.url() !== server.url + "/") return r.continue();
      const patched = HTML.replace(/(\n\s*facebook: ")[^"]*"/, '$1https://www.facebook.com/headscratchsociety"').replace(/(\n\s*instagram: ")[^"]*"/, '$1"').replace(/(\n\s*url: ")[^"]*"/, '$1https://example.org/hss/"');
      assert.notEqual(patched, HTML);
      r.respond({ status: 200, contentType: "text/html; charset=utf-8", body: patched });
    });
  }, init: () => { Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true }); } });
  assert.equal(await s.page.$eval("#follow", e => e.hidden), false);
  assert.deepEqual(await s.page.$$eval("a[data-follow]", e => e.map(a => [a.dataset.follow, a.href])), [["facebook", "https://www.facebook.com/headscratchsociety"]]);
  assert.equal(await s.page.$eval("#fb-inline a", a => a.href), "https://www.facebook.com/headscratchsociety");
  await finishStop(s.page); await press(s.page, "Tab"); await press(s.page, "Enter"); await s.page.waitForSelector("#toast.is-on");
  assert.match(await s.page.evaluate(() => navigator.clipboard.readText()), / Head Scratch Society https:\/\/example\.org\/hss\/$/, "shared text uses the configured address");
  await s.done();
});

test("404 page: served for unknown paths, styled, and links home from any depth", async () => {
  const { page, done } = await open({ pathName: "/no/such/page", expect404: true, width: 390, height: 760 });
  assert.match(await page.title(), /not found/i);
  assert.equal(await page.$$eval("h1", e => e.length), 1);
  assert.equal(await page.$eval("main a", a => a.href), server.url + "/");
  assert.equal(await page.evaluate(() => document.fonts.check('900 20px "Fraunces"')), true, "brand font loads from a nested path");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await done();
});

/* ------------------------------------------------------------------ layout and accessibility */

const PREP = {                                                           // page states to audit, on top of the first view
  dailyDone: async page => { await page.click("#daily-peek"); await page.waitForSelector('#daily[data-state="done"]'); await page.click("#yesterday summary"); },
  wallOpen: async page => { await page.click("#wall-more"); await page.$$eval("#wall-list .wall-card button", bs => bs.forEach(b => b.click())); },
  games: async (page, each) => {
    for (const id of ["stop", "stroop", "memory", "odd", "centre"]) {
      await page.click(`#tab-${id}`); await each(`game ${id}, idle`);
      await page.click(`#panel-${id} [data-go]`); await sleep(150); await each(`game ${id}, playing`);
      if (id === "stroop") { for (let i = 0; i < 4; i++) { await each(`stroop word ${i + 1}`); await page.keyboard.press("1"); } for (let i = 0; i < 8; i++) await page.keyboard.press("1"); await gameDone(page, id); await each("game stroop, result"); }
      if (id === "stop") { await sleep(300); await page.click("#panel-stop [data-go]"); await gameDone(page, id); await each("game stop, result"); }
      if (id === "odd") { await page.click("#odd-grid .odd-cell"); await each("game odd, after a pick"); }
      if (id === "centre") { await page.click("#panel-centre [data-go]"); await each("game centre, middle shown"); }
      if (id === "memory") { await page.waitForSelector("#panel-memory .optbar .opt-btn:not([hidden])", { timeout: 9000 }); await each("game memory, question"); }
    }
  }
};

test("no horizontal overflow at 320, 390, 768 and 1440 wide, in both themes, in every state", async () => {
  const overflow = () => {
    const vw = document.documentElement.clientWidth, bad = [];
    if (document.documentElement.scrollWidth > vw) bad.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
    const clipped = el => { for (let n = el.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o !== "visible") return true; } return false; };
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".sr-only,.skip,.toast,.brand-name,svg") || !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > vw + 0.5 || r.left < -0.5) && !clipped(el)) bad.push(`${el.tagName.toLowerCase()}.${el.className} spills out: ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
      const box = el.parentElement.closest(".card,.wall-card,.stage,.yesterday,.rule");           // nothing may poke out of its own box either
      if (box && r.width) { const b = box.getBoundingClientRect(); if (r.right > b.right + 0.5 || r.left < b.left - 0.5) bad.push(`${el.tagName.toLowerCase()}.${el.className} pokes out of its ${box.className.split(" ")[0]}: ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(b.left)}..${Math.round(b.right)}`); }
    }
    return bad.slice(0, 8);
  };
  for (const theme of ["light", "dark"]) for (const width of [320, 390, 768, 1440]) {
    const { page, done } = await open({ query: "?date=2026-10-13", width, height: 800, theme, motion: "reduce" });
    const check = async what => assert.deepEqual(await page.evaluate(overflow), [], `${theme} ${width}px, ${what}`);
    await check("first view");
    if (theme === "light") {                                              // prove the check can fail
      await page.evaluate(() => { const d = document.createElement("div"); d.id = "too-wide"; d.style.cssText = "width:105vw;height:1px"; document.querySelector("main").append(d); });
      assert.ok((await page.evaluate(overflow)).length >= 1, "the overflow check notices an element that is too wide");
      await page.evaluate(() => document.querySelector("#too-wide").remove());
    }
    await PREP.dailyDone(page); await check("daily answered, yesterday open");
    await PREP.wallOpen(page); await check("whole wall open");
    await PREP.games(page, check);
    await done();
    for (const [date, what] of [["2026-10-05", "typed-answer puzzle"], ["2026-10-18", "puzzle with a quoted sentence"], ["2026-10-10", "long sequence"], ["2026-10-27", "three-sided debate"]]) {
      const s = await open({ query: `?date=${date}`, width, height: 800, theme, motion: "reduce" });
      assert.deepEqual(await s.page.evaluate(overflow), [], `${theme} ${width}px, ${what}`);
      await s.done();
    }
  }
});

test("text contrast meets WCAG AA in both themes, in every state", async () => {
  const audit = () => {
    const parse = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) throw new Error("unreadable colour " + c); const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const bad = []; let checked = 0;
    const backdrop = el => {
      const layers = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage !== "none") { bad.push(`text sits on a background image: <${n.tagName.toLowerCase()} class="${n.className}">`); }
        const c = parse(cs.backgroundColor); if (c.a > 0) { layers.push(c); if (c.a === 1) break; }
      }
      return layers.reverse().reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (el.closest("script,style,noscript,.sr-only,.dood,[hidden]")) continue;      // doodles are decoration; sr-only text is not painted
      if (el.closest(":disabled,[aria-disabled='true']")) continue;                    // WCAG exempts inactive controls
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const range = document.createRange(); range.selectNodeContents(node); const box = range.getBoundingClientRect(); if (box.width < 2 || box.height < 2) continue;
      let opacity = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= +getComputedStyle(n).opacity;
      const cs = getComputedStyle(el), bg = backdrop(el), fg0 = parse(cs.color), fg = over({ ...fg0, a: fg0.a * opacity }, bg);
      const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
      const r = ratio(fg, bg); checked++;
      if (r < (large ? 3 : 4.5)) bad.push(`${r.toFixed(2)}:1 (needs ${large ? 3 : 4.5}) “${node.textContent.trim().slice(0, 40)}” in <${el.tagName.toLowerCase()} class="${el.className}"> ${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`);
    }
    // Controls: the edge of each control (its border, or its fill) must stand out 3:1 from what is around it.
    for (const el of document.querySelectorAll("button,a.btn,input:not([type=radio]):not([type=range]),.opt span,summary,.tab,.filter")) {
      if (el.matches(":disabled,[aria-disabled='true']") || !el.checkVisibility()) continue;
      const cs = getComputedStyle(el), around = backdrop(el.matches("summary") ? el.parentElement.parentElement : el.parentElement);
      const edges = [];
      const holder = el.matches("summary") ? getComputedStyle(el.parentElement) : cs;
      if (parseFloat(holder.borderTopWidth) > 0 && holder.borderTopStyle !== "none") edges.push(over(parse(holder.borderTopColor), around));
      const fill = parse(cs.backgroundColor); if (fill.a > 0) edges.push(over(fill, around));
      if (el.matches(".nav a,.brand,.skip")) continue;                              // plain text links: covered by the text check
      const best = Math.max(0, ...edges.map(e => ratio(e, around))); checked++;
      if (best < 3) bad.push(`${best.toFixed(2)}:1 control edge (needs 3) <${el.tagName.toLowerCase()} class="${el.className}"> “${el.textContent.trim().slice(0, 30)}”`);
    }
    return { bad: [...new Set(bad)].slice(0, 12), checked };
  };
  let total = 0;
  for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
    const { page, done } = await open({ query: "?date=2026-10-13", width, height: 800, theme, motion: "reduce" });
    const check = async what => { const { bad, checked } = await page.evaluate(audit); total += checked; assert.deepEqual(bad, [], `${theme} ${width}px, ${what}`); };
    await check("first view");
    // prove the audit can fail: tomato text on paper is 2.8:1, and a paper-on-paper button has no visible edge
    await page.evaluate(() => { document.querySelector("#today .sub").insertAdjacentHTML("afterend", '<p id="weak" style="background:#fff7e8"><span style="color:#ff5a45">weak text</span><button style="background:#fff7e8;border:0;color:#17132b">edgeless</button></p>'); });
    const planted = (await page.evaluate(audit)).bad;
    assert.equal(planted.length, 2, "the audit catches weak text and an edgeless control: " + planted.join(" | "));
    assert.match(planted[0], /^2\.\d\d:1 \(needs 4\.5\) “weak text”/); assert.match(planted[1], /control edge/);
    await page.evaluate(() => document.querySelector("#weak").remove());
    await page.type("#daily-form .opt input", " "); await page.click("#daily-form button[type=submit]"); await check("daily, after a miss");
    await PREP.dailyDone(page); await check("daily answered, yesterday open");
    await PREP.wallOpen(page); await check("whole wall open");
    await PREP.games(page, check);
    await page.click("#forget"); await check("forget, armed");
    await done();
  }
  for (const theme of ["light", "dark"]) {                              // a debate, answered, and the 404 page
    let s = await open({ query: "?date=2026-10-07", theme, motion: "reduce" });
    await s.page.click("#daily-form .opt input"); await s.page.click("#daily-form button[type=submit]"); await s.page.waitForSelector('#daily[data-state="done"]');
    let res = await s.page.evaluate(audit); total += res.checked; assert.deepEqual(res.bad, [], `${theme}, debate answered`);
    await s.done();
    s = await open({ pathName: "/nowhere", expect404: true, theme });
    res = await s.page.evaluate(audit); total += res.checked; assert.deepEqual(res.bad, [], `${theme}, 404 page`);
    await s.done();
  }
  console.log(`    contrast audit: ${total} pieces of text and control edges checked`);
  assert.ok(total > 4000, `audited ${total} pieces of text and controls`);
});

test("every control can be reached with Tab and shows a clear focus ring", async () => {
  for (const theme of ["light", "dark"]) {
    const { page, done } = await open({ query: "?date=2026-10-13", theme, width: 1280, height: 900, motion: "reduce" });
    const expected = await page.evaluate(() => [...document.querySelectorAll("a[href],button,input,summary,[tabindex='0']")].filter(e => !e.disabled && e.tabIndex >= 0 && e.checkVisibility() && !(e.type === "radio" && e !== document.querySelector(`input[type=radio][name="${e.name}"]`))).length);   // a radio group is one Tab stop
    const seen = new Set(), weak = [];
    for (let i = 0; i < expected + 12; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const parse = c => { const p = /rgba?\(([^)]+)\)/.exec(c)[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
        const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
        const el = document.activeElement; if (!el || el === document.body) return null;
        if (!el.dataset.tabSeen) el.dataset.tabSeen = String(Math.random());
        const ring = el.matches(".opt input") ? el.nextElementSibling : el, cs = getComputedStyle(ring);
        let bg = null; for (let n = ring.parentElement; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a === 1) { bg = c; break; } }
        const [hi, lo] = [lum(parse(cs.outlineColor)), lum(bg || { r: 255, g: 255, b: 255 })].sort((a, b) => b - a);
        return { key: el.dataset.tabSeen, what: `<${el.tagName.toLowerCase()} class="${el.className}" id="${el.id}">`, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), contrast: (hi + 0.05) / (lo + 0.05), matches: el.matches(":focus-visible") };
      });
      if (!info) continue;
      if (seen.has(info.key)) break;
      seen.add(info.key);
      if (!info.matches || info.style === "none" || info.width < 2 || info.contrast < 3) weak.push(`${info.what}: ${info.style} ${info.width}px, ${info.contrast.toFixed(2)}:1`);
    }
    assert.deepEqual(weak, [], `${theme}: focus rings`);
    assert.equal(seen.size, expected, `${theme}: Tab reached ${seen.size} of ${expected} controls`);
    await done();
  }
});

test("touch targets are at least 44 by 44 px on a phone", async () => {
  for (const width of [320, 390]) {
    const { page, done } = await open({ query: "?date=2026-10-13", width, height: 800, motion: "reduce" });
    const small = () => [...document.querySelectorAll("a[href],button,input,summary,label.opt")].filter(e => e.checkVisibility() && !e.closest(".skip") && !e.matches(".opt input")).map(e => { const r = e.getBoundingClientRect(); return { r, what: `${e.tagName.toLowerCase()}.${e.className} “${e.textContent.trim().slice(0, 24)}” ${Math.round(r.width)}x${Math.round(r.height)}` }; }).filter(x => x.r.width < 44 || x.r.height < 44).map(x => x.what);
    const check = async what => assert.deepEqual(await page.evaluate(small), [], `${width}px, ${what}`);
    await check("first view");
    await PREP.dailyDone(page); await check("daily answered");
    await PREP.wallOpen(page); await check("whole wall open");
    await PREP.games(page, check);
    await done();
  }
});

test("reduced motion is respected and nothing loops fast enough to flash", async () => {
  let s = await open({ motion: "reduce" });
  const calm = await s.page.evaluate(() => ({
    dood: getComputedStyle(document.querySelector(".dood")).animationName,
    scratch: getComputedStyle(document.querySelector(".hero-mark .scratch")).animationName,
    scroll: getComputedStyle(document.documentElement).scrollBehavior,
    btn: parseFloat(getComputedStyle(document.querySelector(".btn")).transitionDuration)
  }));
  assert.ok(calm.btn <= 0.001, "transitions are effectively instant");
  assert.deepEqual({ ...calm, btn: 0 }, { dood: "none", scratch: "none", scroll: "auto", btn: 0 });
  await s.done();
  s = await open();
  const loops = await s.page.evaluate(() => [...document.querySelectorAll("*")].map(e => getComputedStyle(e)).filter(cs => cs.animationName !== "none" && cs.animationIterationCount === "infinite").map(cs => parseFloat(cs.animationDuration)));
  assert.ok(loops.length >= 2, "the hero has gentle looping decoration");
  assert.ok(Math.min(...loops) >= 1, "no looping animation cycles faster than once a second");
  assert.equal(await s.page.evaluate(() => getComputedStyle(document.querySelector(".dood")).animationName), "bob");
  await s.done();
});

/* ------------------------------------------------------------------ honesty and hygiene */

test("copy rules: no invented numbers, no engagement bait, no names, no email, no mention of how it is made", async () => {
  const { page, done } = await open({ query: "?date=2026-10-13" });
  await PREP.wallOpen(page);
  const visible = await page.evaluate(() => document.body.innerText);
  const sources = { "index.html": HTML, "404.html": fs.readFileSync(path.join(ROOT, "404.html"), "utf8"), "rendered page": visible };
  const banned = [
    [/\d+\s?%\s+(of\s+)?(people|adults|players|members|users|visitors)/i, "invented statistic"],
    [/\b(most|few|nobody|only \d+) (people|adults|players) (fail|get|can|miss|solve)/i, "invented statistic"],
    [/\b\d[\d,.]*\+?\s+(players|members|followers|fans|scratchers have)/i, "invented count"],
    [/\bas seen on\b|\btestimonial|\bfeatured in\b/i, "invented endorsement"],
    [/\b(comment|type|reply)\s+["“']?(YES|NO|[A-Z]{3,})\b/, "comment bait"],
    [/\btag (a|your|some|someone)\b/i, "tag bait"],
    [/\bshare (this|if|with)\b/i, "share bait"],
    [/\bA\.?I\b\.?|\bartificial intelligence\b|\bmachine[- ]generated\b|\bchatbot\b|\bLLM\b|\bClaude\b|\bGPT\b/, "mention of how it is made"],
    [/[\w.+-]+@[\w-]+\.[\w.]+/, "email address"],
    [/\bErik\b|\bSoto\b/i, "a person's name"]
  ];
  for (const [name, body] of Object.entries(sources)) for (const [re, why] of banned) {
    const hit = re.exec(body.replace(/“most people fail this”/, ""));          // the house rule that quotes the phrase we never use
    assert.equal(hit, null, `${name}: ${why}: “${hit && body.slice(Math.max(0, hit.index - 30), hit.index + 50)}”`);
  }
  assert.match(visible, /Puzzles worth arguing about\./);
  assert.match(visible, /The clue is always in plain sight/);
  await done();
});

test("the verify script passes on the real pool and fails on a wrong answer", () => {
  const run = file => spawnSync(process.execPath, [path.join(ROOT, "tools/verify-puzzles.mjs"), ...(file ? [file] : [])], { encoding: "utf8" });
  const ok = run(); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /OK: every checkable answer matches/);
  const tmp = path.join(os.tmpdir(), `hss-mutant-${process.pid}.html`);
  for (const [from, to] of [['"ans":10,"a":"10 cents."', '"ans":20,"a":"20 cents."'], ['"ans":11,"a":"11 times."', '"ans":12,"a":"12 times."'], ["12-metre wall", "15-metre wall"]]) {
    assert.ok(HTML.includes(from)); fs.writeFileSync(tmp, HTML.replace(from, to));
    const bad = run(tmp); assert.equal(bad.status, 1, `a pool with “${to}” should fail`); assert.match(bad.stderr, /FAIL/);
  }
  fs.rmSync(tmp, { force: true });
});

test("set-url tool writes absolute social tags, and --reset puts the relative ones back", () => {
  const tmp = path.join(os.tmpdir(), `hss-seturl-${process.pid}.html`);
  const start = HTML.replace(/<link rel="canonical"[^>]*>\n/, "").replace(/<meta property="og:url"[^>]*>\n/, "");
  fs.writeFileSync(tmp, start);
  const run = arg => spawnSync(process.execPath, [path.join(ROOT, "tools/set-url.mjs"), arg, tmp], { encoding: "utf8" });
  assert.equal(run("http://insecure.example/").status, 1, "refuses a non-https address");
  assert.equal(run("https://x.example/?utm_source=a").status, 1, "refuses a query string");
  const set = run("https://someone.github.io/head-scratch-society"); assert.equal(set.status, 0, set.stderr);
  let out = fs.readFileSync(tmp, "utf8");
  for (const piece of ['<meta property="og:image" content="https://someone.github.io/head-scratch-society/assets/og.png">', '<meta name="twitter:image" content="https://someone.github.io/head-scratch-society/assets/og.png">', '<meta property="og:url" content="https://someone.github.io/head-scratch-society/">', '<link rel="canonical" href="https://someone.github.io/head-scratch-society/">', 'url: "https://someone.github.io/head-scratch-society/"']) assert.ok(out.includes(piece), piece);
  assert.equal(run("https://someone.github.io/head-scratch-society/").status, 0); assert.equal(fs.readFileSync(tmp, "utf8"), out, "running it twice changes nothing");
  assert.equal(run("--reset").status, 0); out = fs.readFileSync(tmp, "utf8");
  assert.ok(out.includes('<meta property="og:image" content="assets/og.png">') && out.includes('url: ""') && !out.includes("canonical") && !out.includes("og:url"));
  fs.rmSync(tmp, { force: true });
});

test("no external network requests were made by any page in this whole run", () => {
  assert.ok(everyRequest.length > 100, "requests were recorded");
  const alt = `http://${ALT_HOST}:${new URL(server.url).port}/`;       // the same local server under another name
  const outside = [...new Set(everyRequest)].filter(u => !u.startsWith(server.url + "/") && !u.startsWith(alt) && !u.startsWith("data:"));
  assert.deepEqual(outside, []);
  const files = new Set(everyRequest.filter(u => u.startsWith(server.url)).map(u => new URL(u).pathname));
  for (const f of files) if (!["/", "/no/such/page", "/nowhere"].includes(f)) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists in the project`);
  let source = HTML.replace(/xmlns="[^"]+"|"http:\/\/www\.w3\.org\/2000\/svg"/g, "").replace(/\/\/ e\.g\. "[^"]+"/g, "").replace("https://your.site/", "");
  for (const v of Object.values(SITE)) if (v) source = source.split(v).join("");                 // the owner's own configured addresses are fine
  assert.equal(/https?:\/\/[\w.-]+/.exec(source), null, "no absolute URLs in the page source beyond the configured ones");
});
