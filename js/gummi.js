// Gummi stat-boost manipulation solver.
//
// Eating a gummi rolls FIRST, and the eat turn's own advance (it counts as
// standing still, +5 steps) is applied AFTER the rolls:
//
//   1. DungeonRandOutcome(25) — a boost happens at all (25%)?
//   2. DungeonRandInt(16) == 10 → omniboost (all four stats, no further roll)
//   3. otherwise DungeonRandInt(4): 0/1/2/3 = Atk/Def/Sp.Atk/Sp.Def
//   4. then the eat turn's standing advance: +5 steps
//
// The rolls consume 1 (no boost), 2 (omniboost) or 3 (single stat) PRNG
// steps; the eat turn's own advance follows them.
//
// Between gummies the PRNG can be positioned with moves that each cost one
// turn. Two partner modes:
//   Let's go together (the partner follows you):
//     swap places with the partner        +3 steps
//     walk away (partner has to follow)   +4 steps
//     stand still / walk next to partner  +5 steps
//     eating counts as a stand            +5 steps (after the rolls)
//   Wait there (the partner stays put):
//     swap places with the partner        +3 steps
//     any other turn pass                 +4 steps (after the rolls)
//     — walking around, standing still and eating all count the same
//
// An optional `start` offset skips advances that were already performed
// before the manipulation begins (the DP starts at that advance count).
//
// The solver is a forward DP over (PRNG steps consumed, gummies fed) — the
// same exact-approach as the grab bag solver, but over raw LCG steps because
// the per-action advances (3/4/5) and the gummi's own roll consumption
// (1/2/3) don't share a common unit.

import { lcgNext, scaleDraw, DEFAULT_SEED } from "./rng.js";

export const GUMMI_STATS = ["Attack", "Defense", "Sp. Attack", "Sp. Defense"];

// Per partner mode: the eat turn's own advance and the available positioning
// moves (swap / walk away / stand). In Wait there mode the partner stays
// put, so every non-swap turn pass — walking around, standing, eating — is
// a plain +4.
export const PARTNER_MODES = Object.freeze({
  together: Object.freeze({ eatAdvance: 5, moves: Object.freeze([3, 4, 5]) }),
  wait: Object.freeze({ eatAdvance: 4, moves: Object.freeze([3, 4]) }),
});
const MAX_START = 1_000_000; // guard against absurd offset inputs
const CELL_CAP = 8_000_000; // safety cap on (count+1) * window

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** Roll sequence for one gummi from the PRNG state its boost rolls start at. */
export function gummiOutcome(state) {
  const s = lcgNext(state);
  const firstRoll = s >>> 16; // raw 16-bit value the first draw returns
  if (scaleDraw(firstRoll, 100) >= 25) {
    return { boosted: false, omni: false, stat: null, rolls: 1, firstRoll };
  }
  const s2 = lcgNext(s);
  if (scaleDraw(s2 >>> 16, 16) === 10) {
    return { boosted: true, omni: true, stat: null, rolls: 2, firstRoll };
  }
  const s3 = lcgNext(s2);
  return {
    boosted: true,
    omni: false,
    stat: scaleDraw(s3 >>> 16, 4),
    rolls: 3,
    firstRoll,
  };
}

function isAcceptable(outcome, targetStat, omniOnly) {
  if (!outcome.boosted) return false;
  if (omniOnly) return outcome.omni;
  return outcome.omni || outcome.stat === targetStat;
}

/**
 * Solve for the fastest manipulation that feeds `count` gummies, every one
 * landing on an acceptable outcome.
 *
 * @param {number} count   gummies to feed (>= 1)
 * @param {object} [opts]  { targetStat: 0-3, omniOnly: boolean,
 *                           seed: number, window: number,
 *                           start: number, partner: "together"|"wait" }
 * @returns {{cost: number, count: number, targetStat: number, omniOnly: boolean,
 *            segments: Array<{n3: number, n4: number, n5: number,
 *                             omni: boolean, stat: number|null,
 *                             pos: number, rolls: number, rng: string,
 *                             firstRoll: number, advances: number}>,
 *            totalMoves: number}}
 *
 * Segment fields: pos/advances = the PRNG advance count at the moment you
 * eat, counted from the quicksave (the rolls run from there); rolls = steps
 * the rolls consume; rng = the PRNG state at eat time; firstRoll = raw
 * 16-bit value of the first (25% outcome) roll.
 */
export function solveGummi(count, opts = {}) {
  const targetStat = opts.targetStat ?? 0;
  const omniOnly = Boolean(opts.omniOnly);
  const seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
  const mode = PARTNER_MODES[opts.partner === "wait" ? "wait" : "together"];
  const start = opts.start ?? 0;
  // Path length grows ~linearly with the number of gummies (bigger steps
  // between acceptable rolls in omni-only mode); size the window so the
  // default attempt virtually always succeeds.
  const window = opts.window ??
    Math.min(60_000, Math.max(4_000, Math.ceil(((omniOnly ? 100 : 22) * count + 400) * 1.5)));
  if (!Number.isInteger(count) || count < 1) {
    throw fail('bad-count', 'Number of gummies must be a positive whole number.');
  }
  if (!omniOnly && !(Number.isInteger(targetStat) && targetStat >= 0 && targetStat <= 3)) {
    throw fail('bad-stat', 'Pick a stat to optimize for.');
  }
  if (!Number.isInteger(start) || start < 0 || start > MAX_START) {
    throw fail('bad-start',
      'Advances before start must be a whole number between 0 and 1,000,000.');
  }
  if ((count + 1) * (window + 9) > CELL_CAP) {
    throw fail('too-large',
      'That many gummies is too large for the solver (state-space cap). Feed fewer gummies.');
  }

  const LIMIT = window;        // positions simulated beyond `start`
  const END = start + LIMIT;
  const tableLen = END + 9;

  // states[j] = PRNG state after j LCG steps from the quicksave seed.
  const states = new Uint32Array(tableLen);
  states[0] = seed;
  for (let j = 1; j < tableLen; j++) states[j] = lcgNext(states[j - 1]);

  // Per step j: the gummi whose boost rolls start there (the state you eat
  // at — the rolls run before the eat turn's own advance).
  const rollsAt = new Uint8Array(tableLen); // 1/2/3 steps consumed by rolls
  const acceptAt = new Uint8Array(tableLen);
  for (let j = start; j < tableLen; j++) {
    const o = gummiOutcome(states[j]);
    rollsAt[j] = o.rolls;
    acceptAt[j] = isAcceptable(o, targetStat, omniOnly) ? 1 : 0;
  }

  // DP layers: cost[k][d] = fewest turns to have fed k gummies when the PRNG
  // is at advance start + d. parent[k][d] = fromD * 4 + code, code 0-2 =
  // move within the layer, code 3 = eat made from layer k-1 at fromD.
  const INF = 0x3fffffff;
  const cost = [];
  const parent = [];
  for (let k = 0; k <= count; k++) {
    cost.push(new Int32Array(LIMIT + 1).fill(INF));
    parent.push(new Int32Array(LIMIT + 1).fill(-1));
  }
  cost[0][0] = 0;

  for (let k = 0; k < count; k++) {
    const ck = cost[k];
    const pk = parent[k];
    const nk = cost[k + 1];
    const npk = parent[k + 1];
    for (let d = 0; d <= LIMIT; d++) {
      const c = ck[d];
      if (c >= INF) continue;
      const moves = mode.moves;
      for (let m = 0; m < moves.length; m++) {
        const nd = d + moves[m];
        if (nd > LIMIT) continue;
        if (c + 1 < ck[nd]) {
          ck[nd] = c + 1;
          pk[nd] = d * 4 + m;
        }
      }
      // Eat at advance start + d: the gummi's rolls consume steps FIRST
      // (starting from the state you eat at), then the eat turn's own
      // advance (+5 together / +4 in Wait there) follows.
      const i = start + d;
      if (acceptAt[i] === 1) {
        const nd = d + rollsAt[i] + mode.eatAdvance;
        if (nd <= LIMIT && c + 1 < nk[nd]) {
          nk[nd] = c + 1;
          npk[nd] = d * 4 + 3;
        }
      }
    }
  }

  let bestD = -1;
  let bestC = INF;
  for (let d = 0; d <= LIMIT; d++) {
    if (cost[count][d] < bestC) {
      bestC = cost[count][d];
      bestD = d;
    }
  }
  if (bestD < 0) {
    throw fail('no-solution',
      'No manipulation found — the simulated PRNG window was too small.', { window });
  }

  // Rebuild the full action chain (start offset -> best). Moves stay within
  // a layer (k unchanged); an eat (code 3) steps from layer k-1 into k.
  const actions = [];
  {
    let k = count;
    let d = bestD;
    while (!(k === 0 && d === 0)) {
      const p = parent[k][d];
      const fromD = Math.floor(p / 4);
      const code = p % 4;
      actions.push(code);
      d = fromD;
      if (code === 3) k--;
    }
    actions.reverse();
  }

  // Split the chain at each eat: the moves before an eat position it.
  const segments = [];
  const counts = [0, 0, 0];
  for (const code of actions) {
    if (code === 3) {
      // The eat that closed this segment was made from the position the
      // chain was at; recover it from the chain position: the eat's fromI is
      // the current accumulated position. The gummi's rolls run from that
      // state, and the eat turn's +5 lands after them.
      const g = segments.length;
      const prevEnd = g === 0
        ? start
        : segments[g - 1].pos + segments[g - 1].rolls + mode.eatAdvance;
      const j = prevEnd + counts[0] * 3 + counts[1] * 4 + counts[2] * 5;
      const o = gummiOutcome(states[j]);
      segments.push({
        n3: counts[0],
        n4: counts[1],
        n5: counts[2],
        omni: o.omni,
        stat: o.omni ? null : o.stat,
        pos: j,
        rolls: o.rolls,
        rng: states[j].toString(16).padStart(8, '0'),
        // debug: raw 16-bit value the first (25% outcome) roll returns —
        // drawn from the state one LCG step after `pos` — and the number of
        // PRNG advances since the quicksave at the moment of eating.
        firstRoll: o.firstRoll,
        advances: j,
      });
      counts[0] = counts[1] = counts[2] = 0;
    } else {
      counts[code]++;
    }
  }
  const totalMoves = segments.reduce(
    (s, x) => s + x.n3 + x.n4 + x.n5, 0);
  if (totalMoves + count !== bestC) {
    throw fail('internal', 'Solution chain is inconsistent.');
  }

  return {
    cost: bestC,
    count,
    targetStat,
    omniOnly,
    start,
    partner: opts.partner === "wait" ? "wait" : "together",
    segments,
    totalMoves,
  };
}
