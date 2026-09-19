// Secret Bazaar Manipulator — UI controller.
import { solve, DEFAULT_COSTS } from "./solver.js";

const $ = (id) => document.getElementById(id);

const MAX_QTY = 20;
const LEGACY_COSTS_KEY = "pmdb-sb-costs"; // advanced-costs feature removed; stale key cleaned on load

const state = {
  registry: { dungeons: [] },
  items: {},
  relevant: { modes: {} },
  tables: new Map(), // tableId -> table
  dungeonName: null,
  tableId: null,
  team: 4,
  mode: "free", // "story" | "free" — synced from the #mode select in init()
  qty: new Map(), // itemId -> requested quantity (kept across grid rebuilds)
  solveToken: 0,
};

let solveTimer = null;

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`could not load ${path} (HTTP ${res.status})`);
  return res.json();
}

async function ensureTable(tableId) {
  if (!state.tables.has(tableId)) {
    state.tables.set(tableId, await loadJson(`Data/tables/${tableId}.json`));
  }
  return state.tables.get(tableId);
}

function itemName(id) {
  const e = state.items[id];
  return e && e.name ? e.name : `Item ${id}`;
}

function itemIcon(id) {
  const e = state.items[id];
  return e && e.icon ? e.icon : null;
}

function isImagePath(icon) {
  return icon.includes("/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(icon);
}

// Definition of the selected mode (null in Free Selection). Locked modes carry
// an explicit dungeon whitelist { dungeonName: teamSize } — dungeons not
// listed there are not selectable in that mode.
function modeDef() {
  return state.mode === "free" ? null : (state.relevant.modes[state.mode] || null);
}

function filterItemIds(table) {
  const m = modeDef();
  if (!m) return [...new Set(table.items)].sort((a, b) => a - b);
  return Array.isArray(m.items) ? m.items : [];
}

function availableDungeons() {
  const m = modeDef();
  if (!m) return state.registry.dungeons;
  const names = new Set(Object.keys(m.dungeons || {}));
  return state.registry.dungeons.filter((d) => names.has(d.name));
}

// Rebuilds the dungeon dropdown for the current mode, keeping the previous
// selection when it is still available. Returns false when there is no
// dungeon at all for this mode.
function rebuildDungeonOptions() {
  const sel = $("dungeon");
  const prev = sel.value;
  sel.textContent = "";
  const list = availableDungeons();
  for (const d of list) {
    const o = document.createElement("option");
    o.value = d.name;
    o.textContent = d.name;
    sel.appendChild(o);
  }
  const d = list.find((x) => x.name === prev) || list[0];
  if (!d) return false;
  sel.value = d.name;
  state.dungeonName = d.name;
  state.tableId = d.table;
  return true;
}

// Locked modes fix the team size per dungeon (greyed-out dropdown); Free
// Selection leaves the dropdown enabled and keeps the user's choice.
function applyTeamLock() {
  const teamSel = $("team");
  const m = modeDef();
  const locked = m ? Number(m.dungeons[state.dungeonName]) : 0;
  if (locked >= 1 && locked <= 4) {
    teamSel.disabled = true;
    teamSel.value = String(locked);
    state.team = locked;
  } else {
    teamSel.disabled = false;
    state.team = parseInt(teamSel.value, 10) || 4;
  }
}

function renderGrid(table) {
  const inTable = new Set(table.items);
  // In restricted modes, hide items that can't be obtained in this dungeon.
  const ids = filterItemIds(table).filter((id) => inTable.has(id));
  // Drop quantities for items that are no longer selectable (mode/table change).
  const shown = new Set(ids);
  for (const id of [...state.qty.keys()]) {
    if (!shown.has(id)) state.qty.delete(id);
  }
  const grid = $("item-grid");
  grid.textContent = "";
  for (const id of ids) {
    const row = document.createElement("div");
    row.className = "item-row";

    const icon = document.createElement("div");
    icon.className = "item-icon";
    const ic = itemIcon(id);
    if (ic && isImagePath(ic)) {
      const img = document.createElement("img");
      img.src = ic;
      img.alt = "";
      icon.appendChild(img);
    } else {
      icon.textContent = ic || "❔";
    }

    const name = document.createElement("div");
    name.className = "item-name";
    const nm = document.createElement("span");
    nm.textContent = itemName(id);
    const badge = document.createElement("span");
    badge.className = "item-id";
    badge.textContent = `#${id}`;
    name.appendChild(nm);
    name.appendChild(badge);

    const qty = document.createElement("input");
    qty.type = "number";
    qty.className = "qty";
    qty.min = "0";
    qty.max = String(MAX_QTY);
    qty.step = "1";
    qty.value = String(state.qty.get(id) || 0);
    row.classList.toggle("qty-zero", parseInt(qty.value, 10) === 0);
    qty.addEventListener("input", () => {
      const v = Math.max(0, Math.min(MAX_QTY, parseInt(qty.value, 10) || 0));
      state.qty.set(id, v);
      row.classList.toggle("qty-zero", v === 0);
      queueSolve();
    });

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(qty);
    grid.appendChild(row);
  }
}

function queueSolve() {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(() => { void doSolve(); }, 250);
}

function currentRequirements() {
  return [...state.qty.entries()]
    .filter(([, q]) => q > 0)
    .map(([id, q]) => ({ id, qty: q }));
}

async function doSolve() {
  const token = ++state.solveToken;
  const reqs = currentRequirements();
  const resultsPanel = $("results-panel");
  const errorPanel = $("error-panel");

  if (reqs.length === 0) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    $("error-body").innerHTML =
      '<p class="hint">Pick at least one item to generate a manipulation.</p>';
    return;
  }

  let table;
  try {
    table = await ensureTable(state.tableId);
  } catch (e) {
    if (token !== state.solveToken) return;
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    showFatal(e.message);
    return;
  }
  if (token !== state.solveToken) return;

  const t0 = performance.now();
  try {
    const result = solve(table, state.team, reqs);
    if (token !== state.solveToken) return;
    errorPanel.hidden = true;
    resultsPanel.hidden = false;
    renderResults(result, table, performance.now() - t0);
  } catch (e) {
    if (token !== state.solveToken) return;
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    renderError(e);
  }
}

function summaryText(result) {
  const segs = result.segments.map((s, i) => {
    const a = [];
    if (s.partner > 0) a.push(`P${s.partner}`);
    if (s.turn > 0) a.push(`T${s.turn}`);
    return `${i + 1}.${a.join("") || "-"} [${s.itemId}@${s.pos}]`;
  }).join(" ");
  return `${state.dungeonName} (team ${result.teamSize}): ${segs} | total ${result.cost}`;
}

function renderResults(result, table, ms) {
  $("results-title").textContent =
    `${state.dungeonName}, Team of ${result.teamSize}`;
  const body = $("results-body");
  body.textContent = "";

  const manipTable = document.createElement("table");
  manipTable.className = "manip-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["Partner talks", "4-tile dashes", "Attacks", "Item received"]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  manipTable.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const s of result.segments) {
    const tr = document.createElement("tr");
    for (const v of [s.partner, Math.floor(s.turn / 4), s.turn % 4, itemName(s.itemId)]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  manipTable.appendChild(tbody);
  body.appendChild(manipTable);
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function renderError(e) {
  const body = $("error-body");
  body.textContent = "";
  let title = "Something went wrong.";
  let detail = e.message || String(e);
  switch (e.code) {
    case "missing-items":
      title = "Item(s) never appear in this dungeon's table";
      detail = (e.missing || []).map((id) => `${itemName(id)} (#${id})`).join(", ");
      break;
    case "no-solution": {
      const g = gcd(3, 5 + state.team);
      title = "No manipulation exists for this combination";
      detail = g > 1
        ? `With a team of ${state.team}, every PRNG advance is a multiple of ${g}, so only ` +
        `positions 1, ${1 + g}, ${1 + 2 * g}, … can ever be reached — and none of the ` +
        `occurrences of the wanted item(s) sit on those positions. A team of 2 or 3 ` +
        `members can reach every position, so try one of those.`
        : `The wanted item(s) only occur at PRNG positions that cannot be reached with ` +
        `+${5 + state.team} per turn and +3 per partner talk.`;
      break;
    }
    case "too-large":
      title = "That combination is too large for the solver";
      detail = "Fewer items or lower quantities will make it solvable in the browser " +
        "(the state space is capped to keep solving fast).";
      break;
    default:
      break;
  }
  const h = document.createElement("p");
  h.className = "error-title";
  h.textContent = title;
  const d = document.createElement("p");
  d.className = "error-detail";
  d.textContent = detail;
  body.appendChild(h);
  body.appendChild(d);
}

function showFatal(msg) {
  const body = $("error-body");
  body.textContent = "";
  const h = document.createElement("p");
  h.className = "error-title";
  h.textContent = "Could not load data";
  const d = document.createElement("p");
  d.className = "error-detail";
  d.textContent = msg + (location.protocol === "file:"
    ? " — this page loads its data with fetch(), so serve it with a local web server " +
    "(e.g. `python -m http.server` in this folder) or open the GitHub Pages URL."
    : "");
  body.appendChild(h);
  body.appendChild(d);
}

function wireEvents() {
  $("dungeon").addEventListener("change", (e) => {
    const d = state.registry.dungeons.find((x) => x.name === e.target.value);
    if (!d) return;
    state.dungeonName = d.name;
    state.tableId = d.table;
    applyTeamLock();
    void ensureTable(state.tableId).then((table) => {
      renderGrid(table);
      return doSolve();
    });
  });
  $("team").addEventListener("change", (e) => {
    state.team = parseInt(e.target.value, 10);
    queueSolve();
  });
  $("mode").addEventListener("change", (e) => {
    state.mode = e.target.value;
    rebuildDungeonOptions();
    applyTeamLock();
    void ensureTable(state.tableId).then((table) => {
      renderGrid(table);
      return doSolve();
    });
  });
}

async function init() {
  try { localStorage.removeItem(LEGACY_COSTS_KEY); } catch { /* ignore */ }
  try {
    [state.registry, state.items, state.relevant] = await Promise.all([
      loadJson("Data/registry.json"),
      loadJson("Data/items.json"),
      loadJson("Data/relevant.json"),
    ]);
  } catch (e) {
    showFatal(e.message);
    return;
  }
  state.mode = $("mode").value;
  if (!rebuildDungeonOptions()) {
    showFatal("Data/registry.json contains no dungeons. Import a table with tools/import_table.py first.");
    return;
  }
  applyTeamLock();
  wireEvents();
  try {
    const table = await ensureTable(state.tableId);
    renderGrid(table);
  } catch (e) {
    showFatal(e.message);
    return;
  }
  void doSolve();
}

void init();
