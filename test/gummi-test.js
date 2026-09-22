// Self-test for js/gummi.js: the gummi stat-boost DP must reproduce the
// reference results computed with tools/reference_gummi.py, e.g.
//   python tools/reference_gummi.py --count 3 --stat 0
//   -> MACHINE cost=8 segs=1/0/2/1/-1/18|0/0/2/0/0/35|0/0/0/1/-1/43
// If you change the gummi model or solver, regenerate these values.

import { solveGummi, gummiOutcome } from "../js/gummi.js";
import { lcgNext, DEFAULT_SEED } from "../js/rng.js";

/** LCG state after n steps from the quicksave seed (for the replay check). */
function stateAfter(n) {
  let s = DEFAULT_SEED;
  for (let j = 0; j < n; j++) s = lcgNext(s);
  return s;
}

const CASES = [
  { name: "3 gummies · Attack", count: 3, targetStat: 0, omniOnly: false,
    expect: "cost=9 segs=1/0/3/1/-1/18/1443/18|0/0/2/0/0/35/1159/35|0/0/0/1/-1/43/1889/43" },
  { name: "2 gummies · omniboost only", count: 2, targetStat: 0, omniOnly: true,
    expect: "cost=10 segs=1/0/3/1/-1/18/1443/18|1/0/3/1/-1/43/1889/43" },
  { name: "5 gummies · Sp. Attack", count: 5, targetStat: 2, omniOnly: false,
    expect: "cost=24 segs=0/1/1/0/2/9/5422/9|2/0/4/1/-1/43/1889/43|1/1/0/0/2/57/10899/57|1/0/2/0/2/78/13808/78|2/0/4/0/2/112/10327/112" },
  { name: "1 gummi · Sp. Defense", count: 1, targetStat: 3, omniOnly: false,
    expect: "cost=5 segs=1/0/3/1/-1/18/1443/18" },
  { name: "8 gummies · Defense", count: 8, targetStat: 1, omniOnly: false,
    expect: "cost=38 segs=1/0/3/1/-1/18/1443/18|1/0/3/1/-1/43/1889/43|0/0/10/0/1/100/311/100|0/0/2/0/1/118/2517/118|1/1/2/1/-1/143/11042/143|2/0/0/0/1/156/12766/156|0/0/1/0/1/169/11907/169|0/0/3/0/1/192/1232/192" },
  { name: "10 gummies · omniboost only", count: 10, targetStat: 0, omniOnly: true,
    expect: "cost=108 segs=1/0/3/1/-1/18/1443/18|1/0/3/1/-1/43/1889/43|1/0/18/1/-1/143/11042/143|0/0/11/1/-1/205/5270/205|2/0/1/1/-1/223/2004/223|2/0/3/1/-1/251/13774/251|0/1/13/1/-1/327/11131/327|0/1/8/1/-1/378/4479/378|0/1/23/1/-1/504/14348/504|1/1/3/1/-1/533/10977/533" },
  { name: "4 gummies · Attack · Wait there", count: 4, targetStat: 0, omniOnly: false, partner: "wait",
    expect: "cost=18 segs=0/3/0/0/0/12/13387/12|0/4/0/0/0/35/1159/35|0/1/0/0/0/46/10418/46|1/5/0/0/0/76/3920/76" },
  { name: "2 gummies · omniboost only · Wait there", count: 2, targetStat: 0, omniOnly: true, partner: "wait",
    expect: "cost=12 segs=2/3/0/1/-1/18/1443/18|1/4/0/1/-1/43/1889/43" },
  { name: "3 gummies · Sp. Attack · start 600", count: 3, targetStat: 2, omniOnly: false, start: 600,
    expect: "cost=22 segs=2/0/10/0/2/656/4475/656|0/0/1/0/2/669/4892/669|0/0/6/0/2/707/4917/707" },
];

function resultToString(r) {
  const segs = r.segments.map((s) =>
    `${s.n3}/${s.n4}/${s.n5}/${s.omni ? 1 : 0}/${s.stat === null ? -1 : s.stat}/${s.pos}` +
    `/${s.firstRoll}/${s.advances}`
  ).join("|");
  return `cost=${r.cost} segs=${segs}`;
}

const $ = (id) => document.getElementById(id);

function run() {
  const body = $("results-body");
  body.textContent = "";
  let ok = true;
  const rows = [];
  for (const c of CASES) {
    let got;
    try {
      got = resultToString(solveGummi(c.count, {
        targetStat: c.targetStat,
        omniOnly: c.omniOnly,
        seed: DEFAULT_SEED,
        partner: c.partner,
        start: c.start,
      }));
    } catch (e) {
      got = `ERROR: ${e.message}`;
    }
    const pass = got === c.expect;
    if (!pass) ok = false;
    rows.push({ name: c.name, pass, got, want: c.expect });
  }

  // Also replay every solution: simulating the emitted moves + eats must
  // reproduce each segment's position and outcome.
  for (const c of CASES) {
    const r = solveGummi(c.count, {
      targetStat: c.targetStat,
      omniOnly: c.omniOnly,
      seed: DEFAULT_SEED,
      partner: c.partner,
      start: c.start,
    });
    let steps = r.start;
    const eatAdv = r.partner === "wait" ? 4 : 5;
    let replay = "";
    const last = r.segments[r.segments.length - 1];
    for (const s of r.segments) {
      steps += s.n3 * 3 + s.n4 * 4 + s.n5 * 5; // moves position the PRNG
      const o = gummiOutcome(stateAfter(steps)); // rolls run from the eat-time state
      const outcomeOk = r.omniOnly ? o.omni : (o.omni || o.stat === r.targetStat);
      // debug fields: firstRoll must be the raw 16-bit draw one step after
      // the eat, and "advances" must equal the eat-time step count.
      const dbgOk = o.firstRoll === s.firstRoll && s.advances === s.pos;
      // Wait there has no +5 primitive, so n5 must stay 0 there.
      const modeOk = r.partner === "wait" ? s.n5 === 0 : true;
      if (steps !== s.pos || !outcomeOk || !dbgOk || !modeOk) replay += `seg${steps} bad `;
      steps += o.rolls + eatAdv; // roll consumption, then the eat turn's advance
    }
    if (steps !== last.pos + last.rolls + eatAdv) replay += "endpos bad";
    if (replay !== "") ok = false;
    rows.push({ name: `replay · ${r.count} gummies`, pass: replay === "", got: replay || "consistent" });
  }

  const tbl = document.createElement("table");
  tbl.className = "manip-table";
  const thead = document.createElement("thead");
  for (const h of ["Case", "Verdict", "Got", "Expected"]) {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  }
  tbl.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const v of [r.name, r.pass ? "PASS" : "FAIL", r.got, r.want ?? "—"]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  body.appendChild(tbl);
  $("verdict").textContent = ok
    ? "All gummi solver cases passed. ✔"
    : "FAILURES — js/gummi.js diverges from tools/reference_gummi.py.";
}

run();
