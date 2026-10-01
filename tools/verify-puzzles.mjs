// Checks the puzzle pool inside index.html.   node tools/verify-puzzles.mjs [path/to/index.html]
//
// 1. Structure: every puzzle has the fields its kind needs, ids are unique, there are at least 30.
// 2. Answers: every puzzle that CAN be checked by a machine is recomputed or brute-forced here,
//    independently of the answer stored in the pool. A mismatch fails loudly (exit code 1).
// 3. Wording: each check lists phrases that must still be in the puzzle text, so nobody can edit
//    the numbers in a question without this script noticing.
// 4. Riddles that only a human can judge are listed in BY_HAND with the reason they have one answer.
//    A numeric or logic puzzle is never allowed in that list.
// 5. Tone: no invented statistics, no "comment X / tag / share" bait.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(process.argv[2] || path.join(ROOT, "index.html"), "utf8");
const m = /<script type="application\/json" id="puzzle-pool">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error("FAIL: could not find the puzzle pool in index.html"); process.exit(1); }
const POOL = JSON.parse(m[1]);

const problems = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const only = (list, what) => { if (list.length !== 1) throw new Error(`expected exactly one ${what}, found ${list.length}: ${JSON.stringify(list)}`); return list[0]; };
const text = p => [p.big, p.q, p.quote].filter(Boolean).join(" ");
// Must match norm() in index.html.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^(the|a|an) /, "");
const permutations = a => a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [x, ...r]));
const seqOf = p => p.big.replace(/[?\s]/g, "").split(",").filter(Boolean);
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/* ---------- independent solvers. Each returns the value that must equal the pool's answer. ---------- */
const CHECKS = {
  sticker: { needs: ["320 cents", "300 cents more"], solve() {
    const fits = []; for (let s = 0; s <= 320; s++) if (s + (s + 300) === 320) fits.push(s);
    return only(fits, "price");
  } },
  "gaps-double": { needs: ["2, 3, 5, 9, 17"], solve(p) {
    const s = seqOf(p).map(Number), gaps = s.slice(1).map((v, i) => v - s[i]);
    gaps.slice(1).forEach((g, i) => { if (g !== 2 * gaps[i]) throw new Error("gaps do not double"); });
    return s.at(-1) + 2 * gaps.at(-1);
  } },
  snail: { needs: ["12-metre", "climbs 3 metres", "back 2 metres"], solve() {
    let h = 0; for (let day = 1; day < 1000; day++) { h += 3; if (h >= 12) return day; h -= 2; }
  } },
  shorter: { needs: ["five-letter", "shorter", "two letters"], solve(p) {
    const w = p.accept[0]; if (w.length !== 5) throw new Error("not five letters"); if (w + "er" !== "shorter") throw new Error("does not become 'shorter'");
    return w;
  }, against: p => p.accept[0] },
  socks: { needs: ["12 black", "12 white"], solve() {
    for (let n = 1; n <= 24; n++) {            // n is enough if every possible handful of n has two of one colour
      let always = true;
      for (let black = Math.max(0, n - 12); black <= Math.min(12, n); black++) if (black < 2 && n - black < 2) always = false;
      if (always) return n;
    }
  } },
  half: { needs: ["Divide 40 by a half", "add 10"], solve: () => 40 / (1 / 2) + 10 },
  "look-say": { needs: ["1, 11, 21, 1211, 111221"], solve(p) {
    const say = s => s.replace(/(\d)\1*/g, run => run.length + run[0]);
    const s = seqOf(p); s.slice(1).forEach((v, i) => { if (say(s[i]) !== v) throw new Error("given terms are not look-and-say"); });
    return Number(say(s.at(-1)));
  } },
  bakers: { needs: ["6 bakers ice 6 cakes in 6 minutes", "30 bakers", "30 cakes"], solve() {
    const minutesPerCakePerBaker = 6 * 6 / 6;  // 6 bakers x 6 minutes of work made 6 cakes
    return 30 * minutesPerCakePerBaker / 30;
  } },
  gravity: { needs: ["exact centre of gravity"], solve() { const w = "gravity"; if (w.length % 2 === 0) throw new Error("no middle letter"); return w[(w.length - 1) / 2]; }, against: p => p.accept[0] },
  boxes: { needs: ["APPLES, PEARS and MIXED", "every label is on the wrong box", "one fruit"], solve(p) {
    const labels = ["apples", "pears", "mixed"];
    const worlds = permutations(labels).filter(w => w.every((content, i) => content !== labels[i]));   // every label wrong
    const fruits = { apples: ["apple"], pears: ["pear"], mixed: ["apple", "pear"] };
    const good = labels.map((_, box) => {       // drawing from this box works if every possible fruit pins down one world
      const seen = {};
      for (const w of worlds) for (const f of fruits[w[box]]) (seen[f] ||= []).push(w.join());
      return Object.values(seen).every(ws => new Set(ws).size === 1);
    });
    const idx = only(good.map((g, i) => g ? i : -1).filter(i => i >= 0), "box that works");
    if (!p.options[idx].toLowerCase().includes(labels[idx])) throw new Error("option order does not match labels");
    return idx;
  } },
  "order-ops": { needs: ["3 + 3 × 3 − 3 ÷ 3"], solve(p) {
    const expr = p.big.replace(/=.*$/, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
    if (!/^[\d\s+*\/-]+$/.test(expr)) throw new Error("unexpected characters in expression");
    const leftToRight = expr.trim().split(/\s+/).reduce((acc, tok, i, all) => i === 0 ? Number(tok) : i % 2 ? acc : ({ "+": acc + Number(tok), "-": acc - Number(tok), "*": acc * Number(tok), "/": acc / Number(tok) })[all[i - 1]], 0);
    if (!p.trap.includes(`gives ${leftToRight}`)) throw new Error(`trap should say left-to-right gives ${leftToRight}`);
    return Function(`"use strict";return (${expr})`)();
  } },
  pronic: { needs: ["2, 6, 12, 20, 30"], solve(p) {
    const s = seqOf(p).map(Number); s.forEach((v, i) => { if (v !== (i + 1) * (i + 2)) throw new Error("given terms are not n(n+1)"); });
    return (s.length + 1) * (s.length + 2);
  } },
  race: { needs: ["past the runner in second place"], solve(p) {
    const order = ["leader", "second", "third", "you"]; const you = order.indexOf("you"), target = order.indexOf("second");
    order.splice(you, 1); order.splice(target, 0, "you");      // you take the spot of the runner you pass
    const place = order.indexOf("you") + 1;
    return p.options.findIndex(o => o === ["First", "Second", "Third", "Fourth"][place - 1]);
  } },
  "count-f": { needs: ["count every letter F"], solve(p) {
    const n = (p.quote.match(/f/gi) || []).length;
    const perWord = p.quote.replace(/[^a-z ]/gi, "").split(" ").filter(w => /f/i.test(w)).map(w => `${w.toLowerCase()} (${w.match(/f/gi).length})`).join(", ") + ".";
    if (perWord !== p.why) throw new Error(`word-by-word tally in "why" should read: ${perWord}`);
    const ofs = (p.quote.match(/\bof\b/gi) || []).length;
    if (ofs !== 3 || !p.trap.includes("three of them") || !/\boff\b/.test(p.quote)) throw new Error(`the trap says three "of"s and an "off"; the sentence has ${ofs}`);
    return n;
  } },
  ages: { needs: ["When I was 8", "half my age", "I am 50"], solve: () => 50 - (8 - 8 / 2) },
  "digit-7": { needs: ["from 1 to 100", "digit 7"], solve(p) {
    let digits = 0, numbers = 0;
    for (let n = 1; n <= 100; n++) { const c = String(n).split("7").length - 1; digits += c; if (c) numbers++; }
    if (!p.trap.includes(`there are ${numbers} of those`)) throw new Error(`trap should say ${numbers} numbers contain a 7`);
    return digits;
  } },
  ottffss: { needs: ["O, T, T, F, F, S, S"], solve(p) {
    const s = seqOf(p); s.forEach((v, i) => { if (v !== WORDS[i + 1][0].toUpperCase()) throw new Error("given letters are not the counting words"); });
    return WORDS[s.length + 1][0];
  }, against: p => p.accept[0] },
  chocolates: { needs: ["three chocolates", "one right now", "every half hour"], solve() {
    const times = []; for (let i = 0; i < 3; i++) times.push(i * 30); return times.at(-1);
  } },
  incorrectly: { needs: ["always spelled incorrectly"], solve(p) {
    const spelled = /([A-Z](?:-[A-Z])+)/.exec(p.why)[1].replace(/-/g, "").toLowerCase();
    if (spelled !== "incorrectly") throw new Error(`"why" spells ${spelled}`);
    return spelled;
  }, against: p => p.accept[0] },
  robots: { needs: ["Red says: “Blue is lying.”", "Blue says: “Green is lying.”", "Green says: “Red and Blue are both lying.”"], solve(p) {
    const fits = [];
    for (const r of [true, false]) for (const b of [true, false]) for (const g of [true, false]) {
      if (r === !b && b === !g && g === (!r && !b)) fits.push([r, b, g]);   // each robot is truthful exactly when its claim is true
    }
    const world = only(fits, "consistent world");
    const idx = only(world.map((t, i) => t ? i : -1).filter(i => i >= 0), "truthful robot");
    if (p.options[idx] !== ["Red", "Blue", "Green"][idx]) throw new Error("option order does not match robots");
    return idx;
  } },
  snowman: { needs: ["100 cm", "50% taller", "50% of its new height"], solve: () => 100 * 1.5 * 0.5 },
  "letter-count": { needs: ["3, 3, 5, 4, 4, 3, 5, 5, 4"], solve(p) {
    const s = seqOf(p).map(Number); s.forEach((v, i) => { if (v !== WORDS[i + 1].length) throw new Error("given terms are not word lengths"); });
    return WORDS[s.length + 1].length;
  } },
  bell: { needs: ["5 seconds to strike six", "first bong to the last", "strike twelve"], solve: () => (12 - 1) * (5 / (6 - 1)) },
  "new-door": { needs: ["NEW DOOR", "one word"], solve(p) {
    const letters = s => s.toLowerCase().replace(/[^a-z]/g, "").split("").sort().join("");
    if (letters("NEW DOOR") !== letters(p.accept[0])) throw new Error("not an anagram");
    return p.accept[0];
  }, against: () => "one word" },
  animals: { needs: ["fox finishes ahead of the toad but behind the owl", "hare finishes ahead of the owl", "no ties"], solve(p) {
    const fits = permutations(["hare", "fox", "owl", "toad"]).filter(o => { const at = x => o.indexOf(x); return at("fox") < at("toad") && at("owl") < at("fox") && at("hare") < at("owl"); });
    const last = only(fits, "finishing order").at(-1);
    return p.options.findIndex(o => o.toLowerCase().endsWith(last));
  } },
  "clock-hands": { needs: ["at noon", "Counting that one", "before midnight strikes"], solve(p) {
    // Count overlaps in [noon, midnight) by stepping through time and watching the minute hand pass the hour hand.
    let count = 0; const times = []; const step = 0.01;        // seconds
    const lead = t => (((t / 3600 * 360) - (t / 43200 * 360)) % 360 + 360) % 360;   // minute hand's lead over the hour hand, in degrees
    let prev = lead(0); count++; times.push(0);                // together at noon
    for (let t = step; t < 43200 - 1e-6; t += step) { const now = lead(t); if (now < prev) { count++; times.push(t); } prev = now; }
    const exact = []; for (let k = 0; k * 43200 / 11 < 43200 - 1e-9; k++) exact.push(k);
    if (exact.length !== count) throw new Error(`simulation says ${count}, formula says ${exact.length}`);
    const clock = t => { const mins = Math.round(t / 60); return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`; };
    for (const [k, shown] of [[1, "1:05"], [2, "2:11"], [3, "3:16"], [10, "10:55"]]) {
      if (clock(times[k]) !== shown || !p.why.includes(shown)) throw new Error(`meeting ${k} is at ${clock(times[k])}, text says ${shown}`);
    }
    return count;
  } },
  "month-days": { needs: ["31, 28, 31, 30"], solve(p) {
    const days = mo => new Date(Date.UTC(2026, mo + 1, 0)).getUTCDate();   // 2026 is not a leap year
    const s = seqOf(p).map(Number); s.forEach((v, i) => { if (v !== days(i)) throw new Error("given terms are not month lengths"); });
    return days(s.length);
  } },
  plank: { needs: ["into 4 pieces takes 12 minutes", "into 8 pieces", "Every cut takes the same time"], solve: () => (8 - 1) * (12 / (4 - 1)) },
  bookkeeper: { needs: ["three pairs of double letters in a row"], solve(p) {
    for (const w of p.accept) if (!/(.)\1(.)\2(.)\3/.test(w.replace(/[^a-z]/g, ""))) throw new Error(`"${w}" has no three doubles in a row`);
    return p.accept[0];
  }, against: () => "bookkeeper" },
  weekday: { needs: ["day after tomorrow is Sunday", "day before yesterday"], solve(p) {
    const D = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = (D.indexOf("Sunday") - 2 + 7) % 7;
    return p.options.indexOf(D[(today - 2 + 7) % 7]);
  } },
  handshakes: { needs: ["Five people", "everyone else exactly once"], solve() {
    let n = 0; for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) n++; return n;
  } },
  moss: { needs: ["doubles in size every day", "day 24", "half the wall"], solve() {
    let size = 1, day = 24; while (size > 0.5) { size /= 2; day--; } return day;
  } },
  marbles: { needs: ["Nine marbles", "one is slightly heavier", "balance scale"], solve(p) {
    const memo = new Map([[0, 0], [1, 0]]);
    const best = n => {                          // fewest weighings that always finds one heavy marble among n
      if (memo.has(n)) return memo.get(n);
      let b = Infinity; for (let k = 1; 2 * k <= n; k++) b = Math.min(b, 1 + Math.max(best(k), best(n - 2 * k)));
      memo.set(n, b); return b;
    };
    const fourVsFour = 1 + Math.max(best(4), best(1));
    if (fourVsFour !== 3 || !p.trap.includes("three weighings")) throw new Error("the four-against-four claim in the trap is off");
    return best(9);
  } },
  cyclist: { needs: ["10 km/h", "30 km/h", "same road", "average speed for the whole trip"], solve(p) {
    const road = 30, hours = road / 10 + road / 30;
    if (road / 10 !== 3 || road / 30 !== 1 || !p.why.includes("60 km in 4 hours")) throw new Error("worked example in why is off");
    return (2 * road) / hours;
  } },
  daughters: { needs: ["5 daughters", "exactly one brother"], solve: () => 5 + 1 },
  siblings: { needs: ["both girls and boys", "as many brothers as sisters", "twice as many sisters as brothers"], solve(p) {
    const fits = [];
    for (let g = 1; g <= 40; g++) for (let b = 1; b <= 40; b++) if (b === g - 1 && g === 2 * (b - 1)) fits.push([g, b]);
    const [g, b] = only(fits, "family");
    if (!p.a.includes("four girls and three boys") || g !== 4 || b !== 3) throw new Error("girls and boys in the answer are off");
    return g + b;
  } },
  yolk: { needs: ["The yolk of an egg is white", "The yolks of eggs are white"], solve: p => p.options.indexOf("Neither") },
  biscuit: { needs: ["Biscuit's mother had four puppies, and only four", "North, East and South"], solve: p => /^(\w+)'s mother/.exec(p.q)[1].toLowerCase(), against: p => p.accept[0] }
};

/* Riddles a machine cannot judge. Each was re-read looking for a second valid answer. */
const BY_HAND = {
  forest: "“Into” ends at the middle; past it you are heading out. The answer is self-reported, so no spelling can be marked wrong.",
  rooster: "The question asks about an egg that cannot exist. No direction is right.",
  everest: "“Above sea level” rules out Mauna Kea and Chimborazo. Measuring a mountain does not change its height.",
  train: "An electric train makes no smoke, whatever the speeds are.",
  match: "The match must burn before anything else can. “What do you light” does not restrict the choice to the three items.",
  map: "“Fold me up and I fit in your pocket” rules out a globe, an atlas, a model village and a painting."
};
const MACHINE_ONLY = new Set(["number", "story", "sequence", "logic"]);
const TYPES = ["number", "story", "sequence", "riddle", "word", "logic", "debate"];
const BANNED = [
  [/\d+\s?%\s+(of\s+)?(people|adults|players|members|users)/i, "invented statistic"],
  [/\b(most|few|many|nobody|only \w+) (people|adults) (fail|get|can|miss)/i, "invented statistic"],
  [/\b(comment|type|reply)\s+["“']?[A-Z]{2,}["”']?\b/, "comment bait"],
  [/\btag (a|your|some)/i, "tag bait"],
  [/\bshare (this|if|with)/i, "share bait"]
];

/* ---------- run ---------- */
if (!Array.isArray(POOL) || POOL.length < 30) fail("pool", `needs at least 30 puzzles, has ${POOL.length}`);
const ids = new Set();
let checked = 0, byHand = 0, debates = 0;
for (const p of POOL) {
  const id = p.id || "(no id)";
  if (!p.id || ids.has(p.id)) fail(id, "missing or duplicate id"); ids.add(p.id);
  if (!TYPES.includes(p.type)) fail(id, `unknown type ${p.type}`);
  if (!p.q) fail(id, "missing question");
  for (const [re, why] of BANNED) for (const field of [p.big, p.q, p.quote, p.a, p.why, p.trap, p.ask, ...(p.sides || []).map(s => s.case)]) if (field && re.test(field)) fail(id, `${why}: “${field}”`);

  if (p.kind === "debate") {
    debates++;
    if (p.type !== "debate") fail(id, "a debate must be typed as a debate");
    if (!Array.isArray(p.sides) || p.sides.length < 2 || p.sides.some(s => !s.label || !s.case)) fail(id, "a debate needs at least two sides, each with a label and a case");
    if (!p.ask || !p.ask.trim().endsWith("?")) fail(id, "a debate must end on a real question");
    if ("ans" in p || p.a || p.why || p.trap) fail(id, "a debate must not declare an answer");
    const lens = (p.sides || []).map(s => s.case.length); if (Math.max(...lens) > 2.2 * Math.min(...lens)) fail(id, "one side gets far more room than the other");
    continue;
  }
  if (p.type === "debate") fail(id, "typed as a debate but has an answer");
  for (const f of ["a", "why", "trap"]) if (!p[f]) fail(id, `missing ${f}`);
  if (p.kind === "num") { if (typeof p.ans !== "number") fail(id, "num puzzle needs a numeric ans"); else if (!String(p.a).replace(/,/g, "").includes(String(p.ans))) fail(id, `shown answer “${p.a}” does not contain ${p.ans}`); }
  else if (p.kind === "choice") { if (!Array.isArray(p.options) || !(p.ans >= 0 && p.ans < p.options.length)) fail(id, "choice puzzle needs options and a valid ans index"); else if (new Set(p.options).size !== p.options.length) fail(id, "duplicate options"); else { const key = norm(p.options[p.ans]).replace(/^one labelled /, ""); if (!norm(p.a).includes(key)) fail(id, `shown answer “${p.a}” does not match option “${p.options[p.ans]}”`); } }
  else if (p.kind === "text") { if (!Array.isArray(p.accept) || !p.accept.length) fail(id, "text puzzle needs an accept list"); else if (!p.accept.map(norm).includes(norm(p.a))) fail(id, `shown answer “${p.a}” would be marked wrong by its own accept list`); }
  else if (p.kind !== "self") fail(id, `unknown kind ${p.kind}`);

  const check = CHECKS[p.id];
  if (check) {
    for (const phrase of check.needs) if (!text(p).includes(phrase)) fail(id, `wording changed: expected to find “${phrase}”. Update the check as well as the puzzle.`);
    try {
      const got = check.solve(p), want = check.against ? check.against(p) : p.ans;
      if (!eq(got, want)) fail(id, `ANSWER MISMATCH: pool says ${JSON.stringify(want)}, recomputed ${JSON.stringify(got)}`);
      else checked++;
    } catch (e) { fail(id, `check failed: ${e.message}`); }
  } else if (BY_HAND[p.id]) {
    if (MACHINE_ONLY.has(p.type)) fail(id, `a ${p.type} puzzle must be checked by code, not by hand`);
    byHand++;
  } else fail(id, "no check. Add a solver to CHECKS, or (riddles only) a reason to BY_HAND.");
}
for (const id of [...Object.keys(CHECKS), ...Object.keys(BY_HAND)]) if (!ids.has(id)) fail(id, "has a check but is not in the pool");

const counts = TYPES.map(t => `${t} ${POOL.filter(p => p.type === t).length}`).join(", ");
console.log(`Puzzle pool: ${POOL.length} puzzles (${counts}).`);
console.log(`Recomputed by code: ${checked}. Reviewed by hand: ${byHand}. Debates (no single answer): ${debates}.`);
if (problems.length) {
  console.error(`\nFAIL: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  for (const line of problems) console.error("  - " + line);
  process.exit(1);
}
console.log("OK: every checkable answer matches.");
