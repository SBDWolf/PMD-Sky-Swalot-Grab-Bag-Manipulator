// On-the-fly grab bag draw simulation.
//
// The dungeon PRNG (overlay 29) is a linear congruential generator:
//
//   x = (1566083941 * x + 1) mod 2^32
//
// 16-bit draws take the UPPER 16 bits of the state, scaled by
// DungeonRandInt(high) = (upper16 * high) >> 16.
//
// A grab bag purchase consumes three rolls from the PRNG state the purchase
// starts at (verified against all precomputed Data/tables/*.json, 8500/8500
// draws; see tools/verify_model.py):
//
//   1. DungeonRandInt(100) < 50  -> the common pull: Oran Berry (item 70)
//   2. DungeonRandInt(10000)     -> category: first cumulative category
//                                   weight >= the roll
//   3. DungeonRandInt(10000)     -> item within the category's pool: first
//                                   cumulative item weight >= the roll
//
// Position 1's PRNG state is the working value right after a quicksave
// (Data/dungeons.json "seed"); every further position starts one LCG step
// later — which is exactly the +3/+t position advances the solver models.

// Item id -> canonical category name. The floor XML lists the category
// weights first and then ALL item pools in a row, in an order that does NOT
// match the category list — the pools are paired with their categories via
// these ranges instead.
const CATEGORY_RANGES = [
  ["Thrown - Rock", 1, 12],
  ["Hold", 13, 68],
  ["Berries, Seeds, Vitamins", 69, 108],
  ["Foods, Gummies", 109, 136],
  ["Poké (Money)", 183, 183],
  ["TMs, HMs", 187, 292],
  ["Orbs", 301, 359],
  ["Link Box", 360, 362],
];

const COMMON_PULL_ITEM = 70; // Oran Berry
const FAILURE_ITEM = 183; // ITEM_POKE — mirrors the game's corrupted-list fallback

export const DEFAULT_SEED = 0xa61564cd;
export const DEFAULT_WINDOW = 1500; // draw positions generated per solve attempt

function categoryOf(id) {
  for (const [name, lo, hi] of CATEGORY_RANGES) {
    if (id >= lo && id <= hi) return name;
  }
  return null;
}

/** One LCG step. */
export function lcgNext(state) {
  // Math.imul keeps the multiply in int32; >>> 0 applies the mod 2^32.
  return (Math.imul(1566083941, state) + 1) >>> 0;
}

/** DungeonRandInt: scale a 16-bit draw to [0, high). */
export function scaleDraw(raw16, high) {
  return ((raw16 * high) >>> 16); // raw16 * high <= 65535 * 10000 < 2^53
}

/** First index whose cumulative weight is >= roll (the game's pick rule). */
function pickIndex(cums, roll) {
  for (let i = 0; i < cums.length; i++) {
    if (cums[i] >= roll) return i;
  }
  return cums.length - 1;
}

/**
 * Parse the Unk1 (grab bag) ItemList out of a floor_*.xml document.
 *
 * Returns {categories: [{name, cum}], groups: [[{id, cum}]]} where groups[k]
 * is the item pool paired with categories[k] (null when no pool matches).
 */
export function parseBazaarList(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The floor XML could not be parsed.");
  }
  let list = null;
  for (const el of doc.getElementsByTagName("ItemList")) {
    if (el.getAttribute("type") === "Unk1") {
      list = el;
      break;
    }
  }
  if (!list) {
    throw new Error("This dungeon's floor XML has no grab bag (Unk1) item list.");
  }

  const categories = [];
  const rawGroups = [];
  let cur = [];
  for (const el of list.children) {
    if (el.tagName === "Category") {
      const cum = parseInt(el.getAttribute("weight"), 10);
      if (Number.isFinite(cum)) categories.push({ name: el.getAttribute("name"), cum });
    } else if (el.tagName === "Item") {
      const id = parseInt(el.getAttribute("id"), 10);
      const cum = parseInt(el.getAttribute("weight"), 10);
      if (!Number.isFinite(id) || !Number.isFinite(cum)) continue; // e.g. id="GUARANTEED"
      cur.push({ id, cum });
      if (cum >= 10000) {
        // cumulative weights restart at 0 for each category's pool
        rawGroups.push(cur);
        cur = [];
      }
    }
  }
  if (cur.length > 0) rawGroups.push(cur);

  return { categories, groups: pairGroups(categories, rawGroups) };
}

/**
 * Pair category weights with their item pools. Each category takes the
 * unused pool with the most items belonging to it; anything unresolved
 * falls back to pairing the leftovers in listed order.
 */
function pairGroups(categories, rawGroups) {
  const used = new Array(rawGroups.length).fill(false);
  const out = new Array(categories.length).fill(null);
  const unresolved = [];
  categories.forEach((cat, ci) => {
    let best = -1;
    let bestScore = 0;
    rawGroups.forEach((g, gi) => {
      if (used[gi]) return;
      let score = 0;
      for (const it of g) {
        if (categoryOf(it.id) === cat.name) score++;
      }
      if (score > bestScore) {
        best = gi;
        bestScore = score;
      }
    });
    if (best >= 0) {
      out[ci] = rawGroups[best];
      used[best] = true;
    } else {
      unresolved.push(ci);
    }
  });
  if (unresolved.length > 0) {
    const free = [];
    rawGroups.forEach((g, gi) => {
      if (!used[gi]) free.push(g);
    });
    unresolved.forEach((ci, k) => {
      if (k < free.length) out[ci] = free[k];
    });
  }
  return out;
}

/**
 * Simulate the grab bag sequence: n draws starting from `seed`.
 *
 * Returns {items: number[], rng: string[], pool: number[]}
 *   items[p] — the item Swalot sells at position p+1
 *   rng[p]   — the 8-hex-digit PRNG state position p+1 starts from
 *   pool     — every item id that can ever be drawn (for the UI grid and
 *              the "item doesn't exist here" checks)
 */
export function generateTable(list, seed = DEFAULT_SEED, n = DEFAULT_WINDOW) {
  const catCums = list.categories.map((c) => c.cum);
  const groups = list.groups.map((g) =>
    g
      ? { ids: g.map((e) => e.id), cums: g.map((e) => e.cum) }
      : { ids: [], cums: [] },
  );
  const items = new Array(n);
  const rng = new Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    rng[i] = s.toString(16).padStart(8, "0");
    let x = lcgNext(s);
    if (scaleDraw(x >>> 16, 100) < 50) {
      items[i] = COMMON_PULL_ITEM;
    } else {
      x = lcgNext(x);
      const ci = catCums.length > 0 ? pickIndex(catCums, scaleDraw(x >>> 16, 10000)) : -1;
      const g = ci >= 0 ? groups[ci] : null;
      x = lcgNext(x);
      if (g && g.ids.length > 0) {
        items[i] = g.ids[pickIndex(g.cums, scaleDraw(x >>> 16, 10000))];
      } else {
        items[i] = FAILURE_ITEM;
      }
    }
    s = lcgNext(s);
  }
  const pool = new Set([COMMON_PULL_ITEM]);
  for (const g of groups) {
    for (const id of g.ids) pool.add(id);
  }
  return { items, rng, pool: [...pool].sort((a, b) => a - b) };
}
