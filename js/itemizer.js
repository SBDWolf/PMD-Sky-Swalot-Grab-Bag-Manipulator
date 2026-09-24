// Itemizer Orb manipulation solver.
//
// An Itemizer Orb turns one enemy on the floor into an item. The item is
// drawn from the floor's normal item spawn list (ItemList type="Floor")
// using the same two-roll scheme as the grab bag, but WITHOUT the common
// Oran gate: accuracy check, category roll, item roll.
//
// The three orb rolls happen FIRST, from the PRNG state at the moment of
// the throw (confirmed in game — the turn's own advance comes after and is
// irrelevant since the manip ends with the throw):
//   1. +1  accuracy check: DungeonRandInt(100) < 65 must hold
//   2. +1  category: DungeonRandInt(10000)
//   3. +1  item:     DungeonRandInt(10000)
//
// Positioning moves between quicksave and orb throw (1 turn each):
//   swap places with the partner   +17 steps
//   any other turn pass            +18 steps
//
// The solver is the same exact forward DP as the gummi one, over raw LCG
// steps: moves +17/+18 (1 turn each) and a final orb throw that must land
// on the requested item. Chaining multiple orbs is impossible, so the plan
// is always exactly one throw: n17 swaps and/or n18 turn passes, then the
// throw.

import { lcgNext, scaleDraw, DEFAULT_SEED } from "./rng.js";

export const SWAP_ADVANCE = 17; // swap turn advance
const PASS_ADVANCE = 18; // any other turn pass
const ACCURACY_PCT = 65;
const MAX_WINDOW = 200_000;

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** First index whose cumulative weight is >= roll (the game's pick rule). */
function pickIndex(cums, roll) {
  for (let i = 0; i < cums.length; i++) {
    if (cums[i] >= roll) return i;
  }
  return cums.length - 1;
}

/**
 * Simulate one orb throw from the PRNG state at the moment of the throw.
 *
 * The three rolls run FIRST, in order (accuracy, category, item); an
 * accuracy miss ends the sequence after roll 1. `targetItem` (optional)
 * decides whether the outcome counts as a "hit".
 *
 * Returns {hit, itemId, steps, firstRoll, accuracyRoll}. steps counts the
 * PRNG steps the rolls consume (1 miss, 3 hit) — what the turn does after
 * them is outside the scope of the manipulation.
 */
export function orbOutcome(state, list, targetItem = null) {
  const catCums = list.categories.map((c) => c.cum);
  const groups = list.groups.map((g) =>
    g ? { ids: g.map((e) => e.id), cums: g.map((e) => e.cum) } : { ids: [], cums: [] },
  );
  let s = lcgNext(state);
  const firstRoll = s >>> 16; // 1: accuracy check draw
  const accuracyRoll = scaleDraw(firstRoll, 100);
  if (accuracyRoll >= ACCURACY_PCT) {
    return { hit: false, itemId: null, steps: 1, firstRoll, accuracyRoll };
  }
  s = lcgNext(s);
  const ci = catCums.length > 0 ? pickIndex(catCums, scaleDraw(s >>> 16, 10000)) : -1; // 2: category
  const g = ci >= 0 ? groups[ci] : null;
  s = lcgNext(s);
  const itemId =
    g && g.ids.length > 0 ? g.ids[pickIndex(g.cums, scaleDraw(s >>> 16, 10000))] : null; // 3: item
  return {
    hit: itemId !== null && (targetItem === null || itemId === targetItem),
    itemId,
    steps: 3,
    firstRoll,
    accuracyRoll,
  };
}

/**
 * Solve for the fastest manipulation that turns an enemy into `targetItem`.
 *
 * @param {object} list       parsed floor item list (parseFloorList output)
 * @param {number} targetItem item id the orb must produce
 * @param {object} [opts]     { seed: number, window: number }
 * @returns {{cost: number, targetItem: number, window: number,
 *            segment: {n17: number, n18: number, pos: number, rng: string,
 *                      firstRoll: number, accuracyRoll: number,
 *                      advances: number},
 *            totalMoves: number}}
 *
 * Segment fields: pos/advances = PRNG advance count at the moment of the
 * throw (counted from the quicksave); rng = the PRNG state at throw time;
 * firstRoll = raw 16-bit value of the accuracy-check draw (the first roll
 * the throw consumes); accuracyRoll = the scaled DungeonRandInt(100)
 * result of the accuracy check.
 */
export function solveItemizer(list, targetItem, opts = {}) {
  const seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
  const window = opts.window ?? 4_000;
  if (!list || !Array.isArray(list.categories)) {
    throw fail('bad-list', 'No floor item list loaded.');
  }
  if (!Number.isInteger(targetItem)) {
    throw fail('bad-item', 'Pick an item to aim for.');
  }
  if (window > MAX_WINDOW) {
    throw fail('too-large', 'The simulated window is too large.');
  }

  const LIMIT = window;

  // states[j] = PRNG state after j LCG steps from the quicksave seed. The
  // throw at position i reads states[i+1..i+3], so the table extends a few
  // steps past LIMIT.
  const tableLen = LIMIT + SWAP_ADVANCE + 4;
  const states = new Uint32Array(tableLen);
  states[0] = seed;
  for (let j = 1; j < tableLen; j++) states[j] = lcgNext(states[j - 1]);

  // Per step j: does an orb thrown there produce the target item?
  const okAt = new Uint8Array(tableLen);
  const info = new Array(tableLen);
  for (let j = 0; j < tableLen; j++) {
    const o = orbOutcome(states[j], list, targetItem);
    info[j] = o;
    okAt[j] = o.hit ? 1 : 0;
  }

  // DP over (advance count i): cost[i] = fewest turns to reach advance i
  // with positioning moves only. parent[i] = fromI * 4 + code, code 0 =
  // swap (+17), 1 = turn pass (+18). Throwing the orb from position i is
  // the final action and is scored separately.
  const INF = 0x3fffffff;
  const cost = new Int32Array(LIMIT + 1).fill(INF);
  const parent = new Int32Array(LIMIT + 1).fill(-1);
  cost[0] = 0;

  for (let i = 0; i <= LIMIT; i++) {
    const c = cost[i];
    if (c >= INF) continue;
    const s17 = i + SWAP_ADVANCE;
    if (s17 <= LIMIT && c + 1 < cost[s17]) {
      cost[s17] = c + 1;
      parent[s17] = i * 4 + 0;
    }
    const s18 = i + PASS_ADVANCE;
    if (s18 <= LIMIT && c + 1 < cost[s18]) {
      cost[s18] = c + 1;
      parent[s18] = i * 4 + 1;
    }
  }

  // Best throw position: an orb thrown there must hit, and reaching it via
  // moves must be possible.
  let bestI = -1;
  let bestC = INF;
  for (let i = 0; i <= LIMIT; i++) {
    if (okAt[i] === 1 && cost[i] < INF && cost[i] + 1 < bestC) {
      bestC = cost[i] + 1;
      bestI = i;
    }
  }
  if (bestI < 0) {
    throw fail('no-solution',
      'No manipulation found — the simulated PRNG window was too small.',
      { window });
  }

  // Walk the move chain backwards from the throw position.
  const actions = [];
  {
    let i = bestI;
    while (i !== 0) {
      const p = parent[i];
      const fromI = Math.floor(p / 4);
      const code = p % 4;
      if (code > 1) throw fail('internal', 'Corrupt solution chain.');
      actions.push(code);
      i = fromI;
    }
    actions.reverse();
  }

  // Count the moves before the orb throw.
  const counts = [0, 0]; // n17, n18
  for (const code of actions) counts[code]++;
  const totalMoves = counts[0] + counts[1];
  if (totalMoves + 1 !== bestC) {
    throw fail('internal', 'Solution chain is inconsistent.');
  }

  const o = info[bestI];
  return {
    cost: bestC,
    targetItem,
    window,
    segment: {
      n17: counts[0],
      n18: counts[1],
      pos: bestI,
      rng: states[bestI].toString(16).padStart(8, "0"),
      firstRoll: o.firstRoll,
      accuracyRoll: o.accuracyRoll,
      advances: bestI,
    },
    totalMoves,
  };
}
