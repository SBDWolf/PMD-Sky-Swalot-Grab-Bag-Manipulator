// Browser self-test for js/solver.js.
//
// Every "expect" below was produced by tools/reference_solve.py (the Python
// reference implementation of the same DP) and pasted in by hand, e.g.:
//   python tools/reference_solve.py Data/tables/sky-peak.json --team 4 --items 89:3
//   -> MACHINE cost=140 segs=0/45/89/406|0/8/89/481|1/47/89/910
// If you change the cost model in js/solver.js, regenerate these values.

import { solve } from "../js/solver.js";

const TABLES = ["amp-plains", "craggy-coast", "crystal-cave", "mystifying-forest", "sky-peak"];

// expect.segs entries are [partner, turn, itemId, position]; expect.rng checks
// the PRNG shown for each collected position; expect.error expects a throw.
const CASES = [
  { name: "Sky Peak · team 4 · Joy Seed ×1", table: "sky-peak", team: 4, items: { 89: 1 },
    expect: { cost: 45, segs: [[0, 45, 89, 406]], rng: ["ec2bb48e"] } },
  { name: "Sky Peak · team 4 · Joy Seed ×3 (chained, partner)", table: "sky-peak", team: 4, items: { 89: 3 },
    expect: { cost: 140, segs: [[0, 45, 89, 406], [0, 8, 89, 481], [1, 47, 89, 910]],
      rng: ["ec2bb48e", "ad1a3f6d", "bddd2f56"] } },
  { name: "Sky Peak · team 2 · Joy Seed ×1", table: "sky-peak", team: 2, items: { 89: 1 },
    expect: { cost: 46, segs: [[0, 46, 89, 323]] } },
  { name: "Sky Peak · team 1 · Joy Seed ×1", table: "sky-peak", team: 1, items: { 89: 1 },
    expect: { cost: 80, segs: [[0, 80, 89, 481]] } },
  { name: "Sky Peak · team 3 · Joy Seed ×1", table: "sky-peak", team: 3, items: { 89: 1 },
    expect: { cost: 60, segs: [[0, 60, 89, 481]] } },
  { name: "Craggy Coast · team 3 · Link Box ×2", table: "craggy-coast", team: 3, items: { 362: 2 },
    expect: { cost: 104, segs: [[1, 15, 362, 124], [0, 49, 362, 519]] } },
  { name: "Crystal Cave · team 2 · item 27 ×1", table: "crystal-cave", team: 2, items: { 27: 1 },
    expect: { cost: 89, segs: [[1, 49, 27, 347]] } },
  { name: "Amp Plains · team 4 · Link Box + Revive (two items)", table: "amp-plains", team: 4,
    items: { 362: 1, 73: 1 },
    expect: { cost: 53, segs: [[0, 5, 73, 46], [1, 8, 362, 124]] } },
  { name: "Mystifying Forest · team 2 · item 8 ×2", table: "mystifying-forest", team: 2, items: { 8: 2 },
    expect: { cost: 37, segs: [[0, 26, 8, 183], [0, 11, 8, 263]] } },
  { name: "Crystal Cave · team 4 · empty draw ×1 (immediate, free)", table: "crystal-cave", team: 4,
    items: { 70: 1 },
    expect: { cost: 0, segs: [[0, 0, 70, 1]] } },
  { name: "Crystal Cave · team 1 · item 27 ×1 (unreachable)", table: "crystal-cave", team: 1,
    items: { 27: 1 },
    expect: { error: "no-solution" } },
  { name: "Sky Peak · team 4 · ten items ×2 (state-space cap)", table: "sky-peak", team: 4,
    items: { 17: 2, 19: 2, 25: 2, 26: 2, 27: 2, 28: 2, 29: 2, 32: 2, 36: 2, 38: 2 },
    expect: { error: "too-large" } },
  { name: "Sky Peak · team 4 · item 999 ×1 (not in table)", table: "sky-peak", team: 4,
    items: { 999: 1 },
    expect: { error: "missing-items" } },
];

const $ = (id) => document.getElementById(id);

async function loadTable(id) {
  const res = await fetch(`../Data/tables/${id}.json`);
  if (!res.ok) throw new Error(`could not load Data/tables/${id}.json (HTTP ${res.status})`);
  return res.json();
}

function segsToString(segs) {
  return segs.map(([p, t, item, pos]) => `${p}/${t}/${item}/${pos}`).join("|");
}

function runCase(c, tables) {
  const reqs = Object.entries(c.items).map(([id, qty]) => ({ id: Number(id), qty }));
  const t0 = performance.now();
  try {
    const r = solve(tables[c.table], c.team, reqs);
    if (c.expect.error) {
      return { ok: false, detail: `expected error ${c.expect.error} but solver returned cost ${r.cost}` };
    }
    const got = r.segments.map((s) => [s.partner, s.turn, s.itemId, s.pos]);
    const problems = [];
    if (r.cost !== c.expect.cost) problems.push(`cost ${r.cost} (want ${c.expect.cost})`);
    if (segsToString(got) !== segsToString(c.expect.segs)) {
      problems.push(`segments ${segsToString(got)} (want ${segsToString(c.expect.segs)})`);
    }
    if (c.expect.rng) {
      r.segments.forEach((s, i) => {
        if (s.rng !== c.expect.rng[i]) problems.push(`seg ${i + 1} PRNG ${s.rng} (want ${c.expect.rng[i]})`);
      });
    }
    return { ok: problems.length === 0, detail: problems.join("; "), ms: performance.now() - t0 };
  } catch (e) {
    if (c.expect.error && e.code === c.expect.error) {
      return { ok: true, detail: `threw ${e.code} as expected` };
    }
    return { ok: false, detail: `threw ${e.code || "error"}: ${e.message}` };
  }
}

async function runAll() {
  const body = $("test-body");
  const summary = $("summary");
  body.textContent = "";
  summary.textContent = "Loading tables…";

  const tables = {};
  try {
    for (const id of TABLES) tables[id] = await loadTable(id);
  } catch (e) {
    summary.textContent = "Failed to load tables";
    const p = document.createElement("p");
    p.className = "error-detail";
    p.textContent = e.message + (location.protocol === "file:"
      ? " — serve the folder with a local web server (e.g. `python -m http.server`) or open the GitHub Pages URL."
      : "");
    body.appendChild(p);
    return;
  }

  let passed = 0;
  const frag = document.createDocumentFragment();
  for (const c of CASES) {
    const res = runCase(c, tables);
    if (res.ok) passed++;
    const div = document.createElement("div");
    div.className = "item-row" + (res.ok ? "" : " not-in-table");
    const mark = document.createElement("div");
    mark.className = "item-icon";
    mark.textContent = res.ok ? "✓" : "✗";
    mark.style.color = res.ok ? "var(--good)" : "var(--bad)";
    const name = document.createElement("div");
    name.className = "item-name";
    const t1 = document.createElement("span");
    t1.textContent = c.name;
    const t2 = document.createElement("span");
    t2.className = "item-id";
    t2.textContent = res.ok
      ? (res.detail || "ok") + (res.ms !== undefined ? ` · ${res.ms < 10 ? res.ms.toFixed(1) : Math.round(res.ms)} ms` : "")
      : res.detail;
    name.appendChild(t1);
    name.appendChild(t2);
    div.appendChild(mark);
    div.appendChild(name);
    frag.appendChild(div);
  }
  body.appendChild(frag);
  summary.textContent = `${passed}/${CASES.length} passed`;
  summary.style.color = passed === CASES.length ? "var(--good)" : "var(--bad)";
}

$("rerun").addEventListener("click", () => { void runAll(); });
void runAll();
