// Secret Bazaar grab bag manip solver.
//
// Model (see README):
//   * A table is a list of N items. Position p (1-indexed) is the item Swalot
//     sells when you talk to him after advancing the PRNG to the p-th draw.
//     Position 1 = talking to Swalot right after a full reset (no manip).
//   * Actions (all strictly advance the position, so one forward DP pass is
//     an exact shortest path):
//       partner talk          +3 positions, cost 40  (10x a 4-turn dash)
//       pass one turn         +t positions, cost 1   (t = 6/7/8/9 for team 1-4)
//       collect (talk to Swalot at a wanted item) +3 positions, cost 0
//   * Collects may be chained in one run; Swalot is never talked to for an
//     unwanted item.
//
// State = (position index i, remaining-quantity vector). The remaining vector
// is packed into a single mixed-radix integer; state key = i * S + idx.

export const TURN_ADVANCE = [6, 7, 8, 9]; // team size 1..4
export const DEFAULT_COSTS = Object.freeze({ partner: 40, turn: 1, collect: 0 });
const STATE_CAP = 10_000_000; // safety cap on N * S (keeps solving well under ~0.5s)

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * Solve for the fastest manipulation.
 *
 * @param {object} table    { items: number[], rng?: string[] }
 * @param {number} teamSize 1-4
 * @param {Array<{id:number, qty:number}>} requirements  qty >= 1
 * @param {object} [costs]  { partner, turn, collect }
 * @returns {{cost:number, teamSize:number, advance:number,
 *            segments: Array<{partner:number, turn:number, itemId:number,
 *                             pos:number, rng:string|null}>,
 *            totalTurns:number, totalPartners:number,
 *            requirements: Array<[number,number]>}}
 */
export function solve(table, teamSize, requirements, costs = DEFAULT_COSTS) {
  const cPartner = Number(costs.partner ?? DEFAULT_COSTS.partner);
  const cTurn = Number(costs.turn ?? DEFAULT_COSTS.turn);
  const cCollect = Number(costs.collect ?? DEFAULT_COSTS.collect);
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 4) {
    throw fail('bad-team', 'Team size must be 1-4.');
  }
  if (!table || !Array.isArray(table.items) || table.items.length === 0) {
    throw fail('bad-table', 'No table loaded.');
  }

  // Merge duplicate requirement ids.
  const merged = new Map();
  for (const r of requirements) {
    if (!r || !(r.qty > 0)) continue;
    merged.set(r.id, (merged.get(r.id) || 0) + r.qty);
  }
  const reqs = [...merged.entries()];
  if (reqs.length === 0) throw fail('no-items', 'Select at least one item.');

  const items = table.items;
  const N = items.length;
  const t = TURN_ADVANCE[teamSize - 1];

  const itemSet = new Set(items);
  const missing = [...new Set(reqs.filter(([id]) => !itemSet.has(id)).map(([id]) => id))]
    .sort((a, b) => a - b);
  if (missing.length > 0) {
    throw fail('missing-items', 'Item(s) never appear in this dungeon\'s table.', { missing });
  }

  let S = 1;
  for (const [, q] of reqs) S *= q + 1;
  if (N * S > STATE_CAP) {
    throw fail('too-large',
      'This combination is too large for the solver (state-space cap). Reduce the quantities.');
  }

  const stride = [];
  let acc = 1;
  for (const [, q] of reqs) { stride.push(acc); acc *= q + 1; }
  const qty = reqs.map(([, q]) => q);
  const reqIndex = new Map(reqs.map(([id], k) => [id, k]));

  const startIdx = qty.reduce((sum, q, k) => sum + q * stride[k], 0);
  const cost = new Map([[startIdx, 0]]);
  const parent = new Map();
  const byPos = new Array(N);
  for (let i = 0; i < N; i++) byPos[i] = [];
  byPos[0].push(startIdx);
  let pastBest = null; // [cost, prevKey, action] for terminal states past the table

  function relax(ni, nidx, nc, key, action) {
    if (ni < N) {
      const nkey = ni * S + nidx;
      const old = cost.get(nkey);
      if (old === undefined || nc < old) {
        cost.set(nkey, nc);
        parent.set(nkey, [key, action]);
        byPos[ni].push(nidx);
      }
    } else if (nidx === 0) {
      if (pastBest === null || nc < pastBest[0]) pastBest = [nc, key, action];
    }
  }

  for (let i = 0; i < N; i++) {
    const base = i * S;
    const layer = byPos[i];
    for (let li = 0; li < layer.length; li++) {
      const idx = layer[li];
      const key = base + idx;
      const c = cost.get(key);
      if (c === undefined) continue;
      const k = reqIndex.get(items[i]);
      if (k !== undefined && Math.floor(idx / stride[k]) % (qty[k] + 1) > 0) {
        relax(i + 3, idx - stride[k], c + cCollect, key, 2); // collect
      }
      relax(i + 3, idx, c + cPartner, key, 0); // partner talk
      relax(i + t, idx, c + cTurn, key, 1); // pass one turn
    }
  }

  let best = null; // [cost, key, finalAction|null]
  for (let i = 0; i < N; i++) {
    const c = cost.get(i * S);
    if (c !== undefined && (best === null || c < best[0])) best = [c, i * S, null];
  }
  if (pastBest !== null && (best === null || pastBest[0] < best[0])) best = pastBest;
  if (best === null) {
    throw fail('no-solution',
      'No solution: with this team size the PRNG can never land on an occurrence of the wanted item(s).');
  }

  // Rebuild the action chain (start -> final).
  const chain = [];
  if (best[2] !== null) chain.push([best[1], best[2]]);
  let cur = best[1];
  while (parent.has(cur)) {
    const [prevKey, action] = parent.get(cur);
    chain.push([prevKey, action]);
    cur = prevKey;
  }
  chain.reverse();

  const segments = [];
  let p = 0;
  let tn = 0;
  for (const [key, action] of chain) {
    const i = Math.floor(key / S);
    if (action === 0) p++;
    else if (action === 1) tn++;
    else {
      segments.push({
        partner: p,
        turn: tn,
        itemId: items[i],
        pos: i + 1,
        rng: Array.isArray(table.rng) && i < table.rng.length ? table.rng[i] : null,
      });
      p = 0;
      tn = 0;
    }
  }
  const totalTurns = segments.reduce((s, x) => s + x.turn, 0);
  const totalPartners = segments.reduce((s, x) => s + x.partner, 0);
  return {
    cost: best[0],
    teamSize,
    advance: t,
    requirements: reqs,
    segments,
    totalTurns,
    totalPartners,
  };
}
