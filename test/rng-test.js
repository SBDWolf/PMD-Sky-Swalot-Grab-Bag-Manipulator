// Self-test for js/rng.js: the on-the-fly grab bag simulation must reproduce
// the precomputed tables in Data/tables/ exactly (items AND PRNG states).
//
// Serve the repo root (e.g. `python -m http.server`) and open
// /test/rng-test.html.

import { parseBazaarList, generateTable } from "../js/rng.js";

// table id -> dungeon name, mirroring the old Data/registry.json entries.
const CASES = [
  { table: "amp-plains", name: "Amp Plains" },
  { table: "craggy-coast", name: "Craggy Coast" },
  { table: "crystal-cave", name: "Crystal Cave" },
  { table: "mt-travail", name: "Mt. Travail" },
  { table: "mystifying-forest", name: "Mystifying Forest" },
  { table: "sky-peak", name: "Sky Peak Summit Pass" },
];

const SEED_HEX = "a61564cd";
const $ = (id) => document.getElementById(id);

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`could not load ${path} (HTTP ${res.status})`);
  return res.json();
}

async function loadFloor(folder) {
  const res = await fetch(`../dungeon_export/${encodeURIComponent(folder)}/floor_001.xml`);
  if (!res.ok) throw new Error(`could not load floor XML for ${folder} (HTTP ${res.status})`);
  return res.text();
}

async function runCase(dungeons, c) {
  const entry = dungeons.find((d) => d.name === c.name);
  if (!entry) throw new Error(`dungeon "${c.name}" not found in Data/dungeons.json`);
  const [pre, floorXml] = await Promise.all([
    loadJson(`../Data/tables/${c.table}.json`),
    loadFloor(entry.folder),
  ]);
  const list = parseBazaarList(floorXml);
  const gen = generateTable(list, parseInt(SEED_HEX, 16), pre.items.length);
  const itemFails = [];
  const rngFails = [];
  for (let i = 0; i < pre.items.length; i++) {
    if (gen.items[i] !== pre.items[i]) itemFails.push(i + 1);
    // The legacy tables log states via Lua's "%02x" (leading zeros dropped),
    // so compare the 32-bit values, not the strings.
    if (parseInt(gen.rng[i], 16) !== parseInt(pre.rng[i], 16)) rngFails.push(i + 1);
  }
  return {
    name: `${c.name} (${entry.folder})`,
    total: pre.items.length,
    itemFails,
    rngFails,
  };
}

async function main() {
  const body = $("results-body");
  body.textContent = "Running…";
  try {
    const { dungeons } = await loadJson("../Data/dungeons.json");
    const rows = [];
    let ok = true;
    for (const c of CASES) {
      let r;
      try {
        r = await runCase(dungeons, c);
      } catch (e) {
        ok = false;
        rows.push({ name: c.name, error: e.message });
        continue;
      }
      if (r.itemFails.length > 0 || r.rngFails.length > 0) ok = false;
      rows.push(r);
    }

    body.textContent = "";
    const tbl = document.createElement("table");
    tbl.className = "manip-table";
    const thead = document.createElement("thead");
    for (const h of ["Dungeon", "Positions", "Item mismatches", "PRNG mismatches", "Verdict"]) {
      const th = document.createElement("th");
      th.textContent = h;
      thead.appendChild(th);
    }
    tbl.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const cells = r.error
        ? [r.name, "—", "—", "—", `ERROR: ${r.error}`]
        : [r.name, String(r.total),
          r.itemFails.length === 0 ? "none" : r.itemFails.join(", "),
          r.rngFails.length === 0 ? "none" : r.rngFails.join(", "),
          r.itemFails.length === 0 && r.rngFails.length === 0 ? "PASS" : "FAIL"];
      for (const v of cells) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    body.appendChild(tbl);

    const verdict = document.createElement("p");
    verdict.className = ok ? "hint" : "error-title";
    verdict.textContent = ok
      ? "All positions of all tables reproduced exactly. ✔"
      : "MISMATCHES FOUND — the simulation diverges from the precomputed tables.";
    body.appendChild(verdict);
  } catch (e) {
    body.textContent = `Test setup failed: ${e.message}`;
  }
}

void main();
