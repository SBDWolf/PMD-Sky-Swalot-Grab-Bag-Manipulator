// Secret Bazaar Manipulator — UI controller.
//
// Two manipulation tabs share the same quicksave PRNG seed:
//   * Grab Bag — items are NOT read from precomputed tables: js/rng.js
//     simulates the dungeon PRNG on the fly from the floor XML's grab bag
//     list (dungeon_export/<folder>/floor_001.xml, ItemList type="Unk1"), so
//     every dungeon of the game is supported. Only dungeons whose floors can
//     spawn a Secret Bazaar (hidden_stairs != 0 with unk_hidden_stairs
//     0/255) are selectable in Free Selection; Story Dungeons keeps its
//     fixed list.
//   * Gummi Stat Boost — dungeon-independent (js/gummi.js): position the
//     PRNG with partner moves (+3/+4/+5 steps) and feed gummies that must
//     land on a stat boost / omniboost.
import { solve } from "./solver.js";
import { parseBazaarList, generateTable, DEFAULT_SEED, DEFAULT_WINDOW } from "./rng.js";
import { solveGummi, GUMMI_STATS } from "./gummi.js";
import { solveItemizer } from "./itemizer.js";
import { parseFloorList } from "./rng.js";

const $ = (id) => document.getElementById(id);

const LEGACY_COSTS_KEY = "pmdb-sb-costs"; // advanced-costs feature removed; stale key cleaned on load

// The window grows when a solve finds no path within the first 1500 draws.
const WINDOW_STEPS = [DEFAULT_WINDOW, 4 * DEFAULT_WINDOW];

// Story-mode names that don't match a dungeon_export folder name exactly.
const STORY_ALIASES = { "Sky Peak": "Sky Peak Summit Pass" };

const state = {
  dungeons: [], // entries from Data/dungeons.json: {id, name, folder, bazaar}
  dungeonByName: new Map(),
  seed: DEFAULT_SEED,
  items: {},
  relevant: { modes: {} },
  lists: new Map(), // folder -> parsed grab bag list (from floor_001.xml)
  tables: new Map(), // `${folder}|${window}` -> generated table
  floorLists: new Map(), // `${folder}|${floor}` -> parsed Floor item list
  dungeonName: null,
  folder: null,
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

async function loadBazaarList(folder) {
  if (!state.lists.has(folder)) {
    const res = await fetch(`dungeon_export/${encodeURIComponent(folder)}/floor_001.xml`);
    if (!res.ok) throw new Error(`could not load floor XML for ${folder} (HTTP ${res.status})`);
    state.lists.set(folder, parseBazaarList(await res.text()));
  }
  return state.lists.get(folder);
}

// The Floor item list of a specific floor (for the Itemizer Orb tab).
async function loadFloorList(folder, floor) {
  const key = `${folder}|${floor}`;
  if (!state.floorLists.has(key)) {
    const pad = String(floor).padStart(3, "0");
    const res = await fetch(
      `dungeon_export/${encodeURIComponent(folder)}/floor_${pad}.xml`);
    if (!res.ok) throw new Error(`could not load floor XML for ${folder} F${floor} (HTTP ${res.status})`);
    state.floorLists.set(key, parseFloorList(await res.text()));
  }
  return state.floorLists.get(key);
}

// Generates the draw sequence for a dungeon by simulating the PRNG on the
// fly; per (folder, window) results are memoized. `window` is only bumped
// when a solve fails inside the default one.
async function ensureTable(folder, window = DEFAULT_WINDOW) {
  const key = `${folder}|${window}`;
  if (!state.tables.has(key)) {
    const list = await loadBazaarList(folder);
    state.tables.set(key, generateTable(list, state.seed, window));
  }
  return state.tables.get(key);
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
  if (!m) return table.pool;
  const pool = new Set(table.pool);
  return (Array.isArray(m.items) ? m.items : []).filter((id) => pool.has(id));
}

// Free Selection: every dungeon that can actually spawn a Secret Bazaar.
// Story Dungeons: the fixed relevant.json list, in its original order.
function availableDungeons() {
  const m = modeDef();
  if (!m) return state.dungeons.filter((d) => d.bazaar);
  const out = [];
  for (const name of Object.keys(m.dungeons || {})) {
    const d = state.dungeonByName.get(STORY_ALIASES[name] || name);
    if (d) out.push(d);
  }
  return out;
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
  state.folder = d.folder;
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
  // Items that can never be drawn here are hidden (story item lists may
  // reference items this dungeon's grab bag doesn't carry).
  const ids = filterItemIds(table);
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
    qty.step = "1";
    // Empty-when-zero paradigm: the box shows nothing when the quantity is
    // 0, so typing starts fresh (no "10 instead of 1" trap). Focus selects
    // whatever is there, and blurring an empty box falls back to showing 0.
    const refresh = () => {
      const v = state.qty.get(id) || 0;
      qty.value = v === 0 ? "" : String(v);
      qty.placeholder = "0";
      row.classList.toggle("qty-zero", v === 0);
    };
    refresh();
    // No upper cap: the solver bails out with a friendly error when the
    // state space (positions × quantity combinations) gets too large.
    qty.addEventListener("input", () => {
      const v = Math.max(0, Math.trunc(Number(qty.value)) || 0);
      state.qty.set(id, v);
      row.classList.toggle("qty-zero", v === 0);
      queueSolve();
    });
    qty.addEventListener("focus", () => {
      if (qty.value) qty.select();
    });
    qty.addEventListener("blur", refresh);

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

// Grab bag piggyback gummi options (0 gummies = items-only solve).
function grabBagGummiOpts() {
  const n = Math.trunc(Number($("gb-gummies").value));
  return {
    gummies: Number.isFinite(n) && n > 0 ? n : 0,
    targetStat: parseInt($("gb-stat").value, 10) || 0,
    omniOnly: $("gb-omni-only").checked,
  };
}

/** Empty-when-zero behavior for the gummy-count inputs (see renderGrid). */
function zeroPlaceholder(input) {
  const refresh = () => {
    const v = Math.max(0, Math.trunc(Number(input.value)) || 0);
    input.value = v === 0 ? "" : String(v);
    input.placeholder = "0";
  };
  refresh();
  input.addEventListener("focus", () => {
    if (input.value) input.select();
  });
  input.addEventListener("blur", refresh);
}

async function doSolve() {
  const token = ++state.solveToken;
  const reqs = currentRequirements();
  const gummiOpts = grabBagGummiOpts();
  const resultsPanel = $("results-panel");
  const errorPanel = $("error-panel");

  if (reqs.length === 0 && gummiOpts.gummies === 0) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    $("error-body").innerHTML =
      '<p class="hint">Pick at least one item to generate a manipulation.</p>';
    return;
  }

  let table;
  try {
    table = await ensureTable(state.folder);
  } catch (e) {
    if (token !== state.solveToken) return;
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    showFatal(e.message);
    return;
  }
  if (token !== state.solveToken) return;

  const t0 = performance.now();
  let result = null;
  let lastError = null;
  for (const window of WINDOW_STEPS) {
    try {
      if (window !== DEFAULT_WINDOW) {
        table = await ensureTable(state.folder, window);
      }
      result = solve(table, state.team, reqs, gummiOpts);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      // No path inside this window — retry with a longer simulated stretch
      // before giving up (rare: every pool item is drawn constantly).
      if (e.code !== "no-solution" || window === WINDOW_STEPS[WINDOW_STEPS.length - 1]) {
        break;
      }
    }
  }
  if (token !== state.solveToken) return;
  if (lastError) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    renderError(lastError);
    return;
  }
  errorPanel.hidden = true;
  resultsPanel.hidden = false;
  renderResults(result, table, performance.now() - t0);
}

function summaryText(result) {
  const segs = result.segments.map((s, i) => {
    const a = [];
    if (s.partner > 0) a.push(`P${s.partner}`);
    if (s.turn > 0) a.push(`T${s.turn}`);
    const label = s.action === "gummi"
      ? `Gummi:${s.omni ? "Omni" : GUMMI_STATS[s.stat]}↑`
      : s.itemId;
    return `${i + 1}.${a.join("") || "-"} [${label}@${s.pos}]`;
  }).join(" ");
  return `${state.dungeonName} (team ${result.teamSize}): ${segs} | total ${result.cost}`;
}

// Result tables use table-layout: fixed with a <colgroup> built from the
// widths below, so every column keeps the same share of the table however
// the text changes (different item name, "Attack ↑" vs "Sp. Defense ↑").
// Each entry is max(px, %): the percentage is the steady wide-screen
// share; the px floor keeps the widest word readable on narrow screens,
// where the table then overflows and fitTable() scales it down as before.
// Hidden debug columns get no <col> (they create no column while hidden).
const GRABBAG_COL_WIDTHS = [
  "max(56px, 15%)", // Partner talks
  "max(56px, 15%)", // 4-tile dashes
  "max(56px, 15%)", // Attacks
  "max(66px, 25%)", // Action ("Eat gummi" fits on one line even scaled)
  "30%",            // Received
];
const GUMMI_COL_WIDTHS_TOGETHER = [
  "max(46px, 20%)", // Swaps
  "max(74px, 22%)", // Walk-aways
  "max(50px, 26%)", // Turn passes
  "32%",            // Boost
];
const GUMMI_COL_WIDTHS_WAIT = [
  "max(46px, 26%)", // Swaps
  "max(50px, 30%)", // Turn passes
  "44%",            // Boost
];
const ITEMIZER_COL_WIDTHS = [
  "max(46px, 22%)", // Swaps
  "max(50px, 26%)", // Turn passes
  "52%",            // Item
];

/**
 * Apply constant column widths to a result table. Call right after table
 * creation, before the thead goes in (colgroup must precede thead).
 */
function appendColGroup(tbl, widths) {
  const cg = document.createElement("colgroup");
  for (const w of widths) {
    const col = document.createElement("col");
    col.style.width = w;
    cg.appendChild(col);
  }
  tbl.appendChild(cg);
}

function renderResults(result, table, ms) {
  $("results-title").textContent =
    `${state.dungeonName}, Team of ${result.teamSize}` +
    (result.gummies > 0 ? ` + ${result.gummies} gummi${result.gummies === 1 ? "" : "es"}` : "");
  const body = $("results-body");
  body.textContent = "";

  const wrap = document.createElement("div");
  wrap.className = "manip-table-wrap";
  const manipTable = document.createElement("table");
  manipTable.className = "manip-table";
  appendColGroup(manipTable, GRABBAG_COL_WIDTHS);
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["Partner talks", "4-tile dashes", "Attacks", "Action", "Received"]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  manipTable.appendChild(thead);
  const tbody = document.createElement("tbody");
  result.segments.forEach((s, i) => {
    const tr = document.createElement("tr");
    const isGummi = s.action === "gummi";
    const received = isGummi
      ? (s.omni ? "Omniboost" : `${GUMMI_STATS[s.stat]} ↑`)
      : itemName(s.itemId);
    const cells = [
      [s.partner, null],
      [Math.floor(s.turn / 4), null],
      [s.turn % 4, null],
      [isGummi ? "Eat gummi" : "Buy", isGummi ? "act-gummi" : "act-buy"],
      [received, isGummi ? "act-gummi" : null],
    ];
    for (const [v, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = String(v);
      if (typeof v === "number" && v === 0) td.classList.add("zero");
      if (cls) td.classList.add(cls);
      tr.appendChild(td);
    }
    if ((i + 1) % 4 === 0) tr.classList.add("group-end"); // gap every 4 rows
    tbody.appendChild(tr);
  });
  manipTable.appendChild(tbody);
  wrap.appendChild(manipTable);
  body.appendChild(wrap);
  fitTable(manipTable, wrap);

  const total = document.createElement("p");
  total.className = "total";
  const parts = [`${result.totalTurns} passed turns`];
  if (result.totalPartners > 0) {
    parts.push(`${result.totalPartners} partner talk${result.totalPartners === 1 ? "" : "s"} × 40`);
  }
  total.textContent = `Total time: ${result.cost}  (${parts.join(", ")})`;
  body.appendChild(total);
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
      title = "Item(s) never appear in this dungeon's grab bag";
      detail = (e.missing || []).map((id) => `${itemName(id)} (#${id})`).join(", ");
      break;
    case "no-solution": {
      // Team 1 has no partner talk: the only always-available advance is the
      // +6 turn pass (Swalot's own +3 happens only when buying a wanted item).
      const g = state.team === 1 ? 6 : gcd(3, 5 + state.team);
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
    const d = state.dungeonByName.get(e.target.value);
    if (!d) return;
    state.dungeonName = d.name;
    state.folder = d.folder;
    applyTeamLock();
    void ensureTable(state.folder).then((table) => {
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
    void ensureTable(state.folder).then((table) => {
      renderGrid(table);
      return doSolve();
    });
  });
  // grab bag gummi piggyback controls
  const syncStatLock = () => {
    const n = Math.trunc(Number($("gb-gummies").value)) || 0;
    $("gb-stat").disabled = n === 0 || $("gb-omni-only").checked;
  };
  $("gb-gummies").addEventListener("input", () => {
    syncStatLock();
    queueSolve();
  });
  $("gb-stat").addEventListener("change", queueSolve);
  $("gb-omni-only").addEventListener("change", () => {
    syncStatLock();
    queueSolve();
  });
  zeroPlaceholder($("gb-gummies"));
}

// ---- Tabs ---------------------------------------------------------------

function wireTabs() {
  const tabs = document.querySelectorAll("#tabs .tab");
  for (const btn of tabs) {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) return;
      for (const b of tabs) b.classList.toggle("is-active", b === btn);
      for (const page of document.querySelectorAll(".tab-page")) {
        page.hidden = page.id !== `page-${btn.dataset.tab}`;
      }
      // Tables rendered while their tab was hidden were never fitted.
      fitVisibleTables();
    });
  }
}

// ---- Gummi Stat Boost tab ----------------------------------------------

const gummi = { timer: null };

/**
 * Scale an overflowing table down to fit its container (shrink-to-fit).
 * Small screens first get tighter cell padding via CSS; if the table is
 * still too wide it is transformed down to a scale factor >= 0.55.
 *
 * No-op while the table is inside a hidden tab: hidden elements have no
 * layout, so the measurement would be garbage. Tab switching calls
 * fitVisibleTables() to (re)fit everything that just became visible.
 */
function fitTable(tbl, wrap) {
  tbl.style.transform = "";
  tbl.style.width = "";
  if (wrap.style.height) wrap.style.height = "";
  if (!tbl.offsetParent) return; // hidden (display:none ancestor) — skip
  const container = wrap.parentElement ?? wrap;
  const available = container.clientWidth - 2; // panel padding/borders slack
  const needed = tbl.scrollWidth;
  if (needed <= available) return;
  const scale = Math.max(0.55, available / needed);
  // width*100/scale% keeps the scaled table filling the container width
  tbl.style.width = `${100 / scale}%`;
  tbl.style.transform = `scale(${scale})`;
  // scaled height shrinks; keep the layout from reserving unscaled height
  wrap.style.height = `${tbl.getBoundingClientRect().height}px`;
}

/** Re-fit every manip table that is currently rendered and visible. */
function fitVisibleTables() {
  for (const tbl of document.querySelectorAll(".manip-table")) {
    const wrap = tbl.closest(".manip-table-wrap") ?? tbl.parentElement;
    if (tbl.offsetParent) fitTable(tbl, wrap);
  }
}

function queueGummiSolve() {
  clearTimeout(gummi.timer);
  gummi.timer = setTimeout(() => { void doGummiSolve(); }, 250);
}

function wireGummiControls() {
  $("gummi-count").addEventListener("input", queueGummiSolve);
  $("gummi-start").addEventListener("input", queueGummiSolve);
  $("gummi-partner").addEventListener("change", queueGummiSolve);
  $("gummi-stat").addEventListener("change", queueGummiSolve);
  $("gummi-omni-only").addEventListener("change", (e) => {
    $("gummi-stat").disabled = e.target.checked;
    queueGummiSolve();
  });
  zeroPlaceholder($("gummi-start"));
}

async function doGummiSolve() {
  const resultsPanel = $("gummi-results-panel");
  const errorPanel = $("gummi-error-panel");
  const count = Math.trunc(Number($("gummi-count").value));

  if (!Number.isFinite(count) || count < 1) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    $("gummi-error-body").innerHTML =
      '<p class="hint">Set how many gummies you want to feed.</p>';
    return;
  }

  const t0 = performance.now();
  const startRaw = Math.trunc(Number($("gummi-start").value));
  const opts = {
    targetStat: parseInt($("gummi-stat").value, 10) || 0,
    omniOnly: $("gummi-omni-only").checked,
    seed: state.seed,
    start: Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0,
    partner: $("gummi-partner").value === "wait" ? "wait" : "together",
  };
  try {
    let result;
    try {
      result = solveGummi(count, opts);
    } catch (e) {
      // Path didn't fit the default simulated window — retry once longer.
      if (e.code !== "no-solution") throw e;
      result = solveGummi(count, { ...opts, window: Math.min(60_000, (e.window || 16_000) * 4) });
    }
    resultsPanel.hidden = false;
    errorPanel.hidden = true;
    renderGummiResults(result, performance.now() - t0);
  } catch (e) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    renderGummiError(e);
  }
}

function renderGummiResults(result, ms) {
  const goal = result.omniOnly
    ? "Omniboost only"
    : `optimizing ${GUMMI_STATS[result.targetStat]} (or Omniboost)`;
  const wait = result.partner === "wait";
  $("gummi-results-title").textContent =
    `Feeding ${result.count} gummi${result.count === 1 ? "" : "es"}, ${goal}` +
    (wait ? " (Wait there)" : "");
  const body = $("gummi-results-body");
  body.textContent = "";

  const tbl = document.createElement("table");
  tbl.className = "manip-table";
  appendColGroup(tbl, wait ? GUMMI_COL_WIDTHS_WAIT : GUMMI_COL_WIDTHS_TOGETHER);
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  // Move columns depend on the partner mode; the two debug columns stay in
  // the DOM (the data is kept) but hidden.
  const moveHeads = wait ? ["Swaps", "Turn passes"] : ["Swaps", "Walk-aways", "Turn passes"];
  for (const [h, hidden] of [
    ...moveHeads.map((h) => [h, false]),
    ["Boost", false],
    ["Rand16Bit", true],
    ["Advances", true],
  ]) {
    const th = document.createElement("th");
    th.textContent = h;
    th.hidden = hidden;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
thead.appendChild(htr);
  tbl.appendChild(thead);
  const tbody = document.createElement("tbody");
  result.segments.forEach((s, i) => {
    const tr = document.createElement("tr");
    const moveCells = wait ? [s.n3, s.n4] : [s.n3, s.n4, s.n5];
    [...moveCells,
      s.omni ? "Omniboost" : `${GUMMI_STATS[s.stat]} ↑`,
      s.firstRoll,
      s.advances,
    ].forEach((v, ci) => {
      const td = document.createElement("td");
      td.textContent = String(v);
      if (typeof v === "number" && v === 0) td.classList.add("zero");
      if (ci >= moveHeads.length + 1) td.hidden = true; // debug columns
      tr.appendChild(td);
    });
    if ((i + 1) % 4 === 0) tr.classList.add("group-end"); // gap every 4 rows
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  body.appendChild(tbl);
  fitTable(tbl, body);

  const total = document.createElement("p");
  total.className = "total";
  total.textContent =
    `Total time: ${result.cost} turns ` +
    `(${result.totalMoves} moves, ${result.count} gumm${result.count === 1 ? "i" : "ies"} eaten)`;
  body.appendChild(total);
}

// ---- Itemizer Orb tab ---------------------------------------------------

const itemizer = { timer: null, dungeonName: null, folder: null, floor: 1 };

function queueItemizerSolve() {
  clearTimeout(itemizer.timer);
  itemizer.timer = setTimeout(() => { void doItemizerSolve(); }, 250);
}

// Dungeon dropdown for the Itemizer tab: all dungeons (they all have floors).
function rebuildItemizerDungeons() {
  const sel = $("it-dungeon");
  sel.textContent = "";
  for (const d of state.dungeons) {
    const o = document.createElement("option");
    o.value = d.name;
    o.textContent = d.name;
    sel.appendChild(o);
  }
  const first = state.dungeons[0];
  if (!first) return false;
  sel.value = first.name;
  itemizer.dungeonName = first.name;
  itemizer.folder = first.folder;
  return true;
}

function rebuildItemizerFloors() {
  const sel = $("it-floor");
  sel.textContent = "";
  const d = state.dungeonByName.get(itemizer.dungeonName);
  const floors = d ? Math.max(1, d.floors || 1) : 1;
  for (let f = 1; f <= floors; f++) {
    const o = document.createElement("option");
    o.value = String(f);
    o.textContent = f === floors ? `${f}` : `${f}`;
    sel.appendChild(o);
  }
  sel.value = String(Math.min(itemizer.floor, floors));
  itemizer.floor = parseInt(sel.value, 10);
}

function rebuildItemizerItems(list) {
  const sel = $("it-item");
  const prev = sel.value; // keep the user's selection across re-renders
  sel.textContent = "";
  const head = document.createElement("option");
  head.value = "";
  head.textContent = "— pick an item —";
  sel.appendChild(head);
  for (const id of list.pool) {
    const o = document.createElement("option");
    o.value = String(id);
    o.textContent = `${itemName(id)} (#${id})`;
    sel.appendChild(o);
  }
  // Restore the previously selected item when it still exists in this pool.
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  }
}

function wireItemizerControls() {
  $("it-dungeon").addEventListener("change", (e) => {
    itemizer.dungeonName = e.target.value;
    const d = state.dungeonByName.get(e.target.value);
    itemizer.folder = d ? d.folder : null;
    itemizer.floor = 1;
    rebuildItemizerFloors();
    queueItemizerSolve();
  });
  $("it-floor").addEventListener("change", (e) => {
    itemizer.floor = parseInt(e.target.value, 10) || 1;
    queueItemizerSolve();
  });
  $("it-item").addEventListener("change", queueItemizerSolve);
}

async function doItemizerSolve() {
  const resultsPanel = $("it-results-panel");
  const errorPanel = $("it-error-panel");
  const target = parseInt($("it-item").value, 10);

  // Load the floor's item list first: it feeds both the item dropdown and
  // the solve, so the dropdown stays populated even with no item picked.
  try {
    const list = await loadFloorList(itemizer.folder, itemizer.floor);
    rebuildItemizerItems(list);
    if (!Number.isInteger(target)) {
      resultsPanel.hidden = true;
      errorPanel.hidden = false;
      $("it-error-body").innerHTML =
        '<p class="hint">Pick the item the orb should produce.</p>';
      return;
    }
    const t0 = performance.now();
    let result;
    try {
      result = solveItemizer(list, target, { seed: state.seed });
    } catch (e) {
      if (e.code !== "no-solution") throw e;
      result = solveItemizer(list, target,
        { seed: state.seed, window: Math.min(200_000, (e.window || 4_000) * 8) });
    }
    resultsPanel.hidden = false;
    errorPanel.hidden = true;
    renderItemizerResults(result, performance.now() - t0);
  } catch (e) {
    resultsPanel.hidden = true;
    errorPanel.hidden = false;
    renderItemizerError(e);
  }
}

function renderItemizerResults(result, ms) {
  $("it-results-title").textContent =
    `Itemizing — ${itemName(result.targetItem)}`;
  const body = $("it-results-body");
  body.textContent = "";

  const s = result.segment;
  const tbl = document.createElement("table");
  tbl.className = "manip-table";
  appendColGroup(tbl, ITEMIZER_COL_WIDTHS);
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  // Debug columns stay in the DOM (the data is kept) but hidden.
  for (const [h, hidden] of [
    ["Swaps", false],
    ["Turn passes", false],
    ["Item", false],
    ["Rand16Bit", true],
    ["Accuracy", true],
    ["Advances", true],
  ]) {
    const th = document.createElement("th");
    th.textContent = h;
    th.hidden = hidden;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  tbl.appendChild(thead);
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  [s.n17, s.n18, itemName(result.targetItem), s.firstRoll, s.accuracyRoll, s.advances]
    .forEach((v, ci) => {
      const td = document.createElement("td");
      td.textContent = String(v);
      if (typeof v === "number" && v === 0) td.classList.add("zero");
      if (ci >= 3) td.hidden = true; // debug columns
      tr.appendChild(td);
    });
  tbody.appendChild(tr);
  tbl.appendChild(tbody);
  body.appendChild(tbl);
  fitTable(tbl, body);

  const total = document.createElement("p");
  total.className = "total";
  total.textContent =
    `Total time: ${result.cost} turns ` +
    `(${result.totalMoves} moves, orb thrown at advance ${s.advances})`;
  body.appendChild(total);
}

function renderItemizerError(e) {
  const body = $("it-error-body");
  body.textContent = "";
  const h = document.createElement("p");
  h.className = "error-title";
  const d = document.createElement("p");
  d.className = "error-detail";
  let title = "Something went wrong.";
  let detail = e.message || String(e);
  if (e.code === "no-solution") {
    title = "No manipulation exists for this combination";
    detail = "The PRNG never lands on this item (with a passing accuracy roll) within " +
      "the simulated window. Try another floor or another item.";
  } else if (e.code === "too-large") {
    title = "That combination is too large for the solver";
    detail = "The simulated window is capped to keep solving fast.";
  }
  h.textContent = title;
  d.textContent = detail;
  body.appendChild(h);
  body.appendChild(d);
}

async function init() {
  try { localStorage.removeItem(LEGACY_COSTS_KEY); } catch { /* ignore */ }
  try {
    const [dungeonData, items, relevant] = await Promise.all([
      loadJson("Data/dungeons.json"),
      loadJson("Data/items.json"),
      loadJson("Data/relevant.json"),
    ]);
    state.dungeons = dungeonData.dungeons || [];
    state.seed = parseInt(dungeonData.seed, 16) || DEFAULT_SEED;
    state.items = items;
    state.relevant = relevant;
    state.dungeonByName = new Map(state.dungeons.map((d) => [d.name, d]));
  } catch (e) {
    showFatal(e.message);
    return;
  }
  state.mode = $("mode").value;
  if (!rebuildDungeonOptions()) {
    showFatal("No selectable dungeons. Run `python tools/export_dungeons.py` to (re)generate " +
      "Data/dungeons.json from the dungeon_export XML dump.");
    return;
  }
  applyTeamLock();
  wireEvents();
  wireTabs();
  wireGummiControls();
  void doGummiSolve();
  if (rebuildItemizerDungeons()) {
    rebuildItemizerFloors();
    wireItemizerControls();
    void doItemizerSolve();
  }
  try {
    const table = await ensureTable(state.folder);
    renderGrid(table);
  } catch (e) {
    showFatal(e.message);
    return;
  }
  void doSolve();
}

void init();
